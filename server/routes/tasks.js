import { Router } from 'express';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { runGeneration, runExecution, runPlanning } from '../agents/runner.js';

const router = Router();

router.get('/tasks', (req, res) => {
  const { projectId } = req.query;
  res.json(state.getTasks(projectId));
});

router.get('/tasks/queue', (req, res) => {
  const { projectId } = req.query;
  if (projectId) {
    res.json(state.getQueueSnapshot(projectId));
  } else {
    res.json(state.getAllQueues());
  }
});

router.patch('/tasks/:id', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'proposed' && task.status !== 'planned') {
    return res.status(400).json({ error: `Cannot edit task with status '${task.status}'` });
  }

  const allowedFields = ['title', 'description', 'rationale', 'effort'];
  if (task.status === 'planned') allowedFields.push('plan');

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (updates.effort && !['small', 'medium', 'large'].includes(updates.effort)) {
    return res.status(400).json({ error: 'effort must be small, medium, or large' });
  }

  const updated = state.updateTask(req.params.id, updates);
  broadcast('task:updated', updated);
  res.json(updated);
});

router.post('/generate', async (req, res) => {
  const { projectId, templateId, modelId, promptContent } = req.body;
  let projects;

  if (projectId) {
    const project = state.getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    projects = [project];
  } else {
    projects = state.getProjects();
  }

  if (projects.length === 0) {
    return res.status(400).json({ error: 'No projects to generate for' });
  }

  // Fire and forget — results come via WebSocket
  res.json({ message: 'Generation started', projectCount: projects.length });

  // Run generation for all projects concurrently (read-only, safe)
  const results = await Promise.allSettled(
    projects.map((p) => runGeneration(p, templateId, modelId, promptContent))
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('Generation failed:', r.reason.message);
    }
  }
});

router.post('/tasks/:id/plan', async (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'proposed') {
    return res.status(400).json({ error: `Task is ${task.status}, not proposed` });
  }

  const { modelId } = req.body || {};

  // Fire and forget — results come via WebSocket
  res.json({ message: 'Planning started', taskId: task.id });

  try {
    await runPlanning(task, modelId);
  } catch (err) {
    console.error('Planning failed:', err.message);
  }
});

router.post('/tasks/:id/execute', async (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'proposed' && task.status !== 'planned') {
    return res.status(400).json({ error: `Task is ${task.status}, expected proposed or planned` });
  }

  const { modelId } = req.body || {};

  if (state.isProjectLocked(task.projectId)) {
    // Project is busy — enqueue instead of rejecting
    state.updateTask(task.id, { status: 'queued', executedBy: modelId || null });
    const position = state.enqueueTask(task.projectId, task.id);
    broadcast('execution:queued', { taskId: task.id, position, projectId: task.projectId });
    broadcast('execution:queue-updated', state.getQueueSnapshot(task.projectId));
    return res.json({ message: 'Queued for execution', taskId: task.id, position });
  }

  // Fire and forget — results come via WebSocket
  res.json({ message: 'Execution started', taskId: task.id });

  try {
    await runExecution(task, modelId);
  } catch (err) {
    console.error('Execution failed:', err.message);
  }
});

router.post('/tasks/:id/dequeue', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'queued') {
    return res.status(400).json({ error: `Task is ${task.status}, not queued` });
  }

  state.removeFromQueue(task.projectId, task.id);
  const revertStatus = task.plan ? 'planned' : 'proposed';
  state.updateTask(task.id, { status: revertStatus });
  broadcast('execution:dequeued', { taskId: task.id, projectId: task.projectId });
  broadcast('execution:queue-updated', state.getQueueSnapshot(task.projectId));
  res.json({ message: 'Removed from queue', taskId: task.id });
});

router.post('/tasks/:id/abort', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'executing') {
    return res.status(400).json({ error: `Task is ${task.status}, not executing` });
  }

  const handle = state.getProcess(task.id);
  if (!handle || !handle.proc) {
    return res.json({ message: 'Task is no longer running', taskId: task.id });
  }

  state.markAborted(task.id);

  try {
    handle.proc.kill('SIGTERM');
  } catch {
    // Process may have already exited
  }

  // SIGKILL fallback after 5 seconds
  setTimeout(() => {
    try {
      handle.proc.kill('SIGKILL');
    } catch {
      // Already dead, ignore
    }
  }, 5000);

  res.json({ message: 'Abort signal sent', taskId: task.id });
});

router.post('/tasks/:id/dismiss', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Kill running agent subprocess if task is mid-planning
  const proc = state.getProcess(req.params.id);
  if (proc) {
    proc.kill('SIGTERM');
    state.removeProcess(req.params.id);
  }

  const projectId = task.projectId;
  const wasQueued = task.status === 'queued';
  state.removeTask(req.params.id);
  broadcast('task:dismissed', { id: req.params.id });
  if (wasQueued) {
    broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
  }
  res.status(204).end();
});

export default router;
