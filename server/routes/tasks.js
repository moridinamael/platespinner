import { Router } from 'express';
import { execFile } from 'child_process';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';
import * as state from '../state.js';
import { LOGS_DIR } from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { runGeneration, runExecution, runPlanning } from '../agents/runner.js';

const router = Router();

router.get('/tasks', (req, res) => {
  const { projectId } = req.query;
  const tasks = state.getTasks(projectId);
  // Strip diff field from list response to keep payload small
  res.json(tasks.map(({ diff, ...rest }) => rest));
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

  const EDITABLE_FIELDS = ['title', 'description', 'rationale', 'effort', 'plan'];
  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
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

  // Check budget before execution
  const project = state.getProject(task.projectId);
  if (project && project.budgetLimitUsd != null) {
    const projectTasks = state.getTasks(task.projectId);
    const totalSpent = projectTasks.reduce((sum, t) => sum + (t.costUsd || 0), 0);
    if (totalSpent >= project.budgetLimitUsd) {
      return res.status(400).json({
        error: 'Budget limit exceeded',
        totalSpent,
        budgetLimit: project.budgetLimitUsd,
      });
    }
  }

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

// --- Diff endpoint ---

router.get('/tasks/:id/diff', async (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Return stored diff if available
  if (task.diff) {
    return res.json({ diff: task.diff, source: 'stored' });
  }

  // Try to compute from git if commitHash exists
  if (task.commitHash) {
    const project = state.getProject(task.projectId);
    if (!project) return res.json({ diff: null, source: 'unavailable' });

    const cwd = toWSLPath(project.path);

    try {
      const diff = await new Promise((resolve, reject) => {
        execFile('git', ['diff', `${task.commitHash}~1..${task.commitHash}`],
          { cwd, maxBuffer: 5 * 1024 * 1024 },
          (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
          });
      });
      if (diff) {
        // Cache on task for future requests
        state.updateTask(task.id, { diff });
      }
      return res.json({ diff: diff || null, source: 'computed' });
    } catch {
      return res.json({ diff: null, source: 'unavailable' });
    }
  }

  res.json({ diff: null, source: 'unavailable' });
});

// --- Log endpoints ---

router.get('/tasks/:id/logs', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const phases = ['generation', 'planning', 'execution', 'judgment'];
  const available = [];
  for (const phase of phases) {
    const logFile = join(LOGS_DIR, `${task.id}-${phase}.log`);
    try {
      const stats = statSync(logFile);
      available.push({ phase, size: stats.size });
    } catch { /* not found */ }
  }
  res.json(available);
});

router.get('/tasks/:id/logs/:phase', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const phase = req.params.phase;
  if (!['generation', 'planning', 'execution', 'judgment'].includes(phase)) {
    return res.status(400).json({ error: 'Invalid phase' });
  }

  const logFile = join(LOGS_DIR, `${task.id}-${phase}.log`);
  try {
    const stats = statSync(logFile);
    res.set('Content-Type', 'text/plain');
    res.set('X-Log-Size', stats.size.toString());
    createReadStream(logFile).pipe(res);
  } catch {
    return res.status(404).json({ error: 'Log file not found' });
  }
});

// --- Batch operations ---

router.post('/tasks/batch', async (req, res) => {
  const { action, taskIds, modelId } = req.body;
  if (!action || !Array.isArray(taskIds)) {
    return res.status(400).json({ error: 'action and taskIds[] are required' });
  }
  if (!['plan', 'execute', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: 'action must be plan, execute, or dismiss' });
  }
  if (taskIds.length === 0) {
    return res.json({ message: `Batch ${action}: nothing to do`, count: 0 });
  }

  if (action === 'plan') {
    const validTasks = taskIds
      .map(id => state.getTask(id))
      .filter(t => t && t.status === 'proposed');
    if (validTasks.length === 0) {
      return res.json({ message: 'No proposed tasks to plan', count: 0 });
    }
    res.json({ message: 'Batch planning started', count: validTasks.length });

    // Concurrency-limited planning
    const PLAN_CONCURRENCY = 3;
    let active = 0;
    const queue = [...validTasks];

    function runNext() {
      while (queue.length > 0 && active < PLAN_CONCURRENCY) {
        active++;
        const task = queue.shift();
        runPlanning(task, modelId)
          .catch(err => console.error('Batch plan failed:', err.message))
          .finally(() => { active--; runNext(); });
      }
    }
    runNext();
  } else if (action === 'execute') {
    const validTasks = taskIds
      .map(id => state.getTask(id))
      .filter(t => t && (t.status === 'planned' || t.status === 'proposed'))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (validTasks.length === 0) {
      return res.json({ message: 'No tasks to execute', count: 0 });
    }

    let queued = 0;
    let started = 0;

    for (const task of validTasks) {
      // Budget check
      const project = state.getProject(task.projectId);
      if (project && project.budgetLimitUsd != null) {
        const projectTasks = state.getTasks(task.projectId);
        const totalSpent = projectTasks.reduce((sum, t) => sum + (t.costUsd || 0), 0);
        if (totalSpent >= project.budgetLimitUsd) continue; // skip over-budget tasks
      }

      if (state.isProjectLocked(task.projectId)) {
        state.updateTask(task.id, { status: 'queued', executedBy: modelId || null });
        const position = state.enqueueTask(task.projectId, task.id);
        broadcast('execution:queued', { taskId: task.id, position, projectId: task.projectId });
        broadcast('execution:queue-updated', state.getQueueSnapshot(task.projectId));
        queued++;
      } else {
        started++;
        // Fire and forget
        runExecution(task, modelId).catch(err => console.error('Batch execute failed:', err.message));
      }
    }

    res.json({ message: 'Batch execution started', count: validTasks.length, started, queued });
  } else if (action === 'dismiss') {
    let count = 0;
    for (const id of taskIds) {
      const task = state.getTask(id);
      if (!task) continue;

      const handle = state.getProcess(id);
      if (handle) {
        const proc = handle.proc || handle;
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        state.removeProcess(id);
      }

      const projectId = task.projectId;
      const wasQueued = task.status === 'queued';
      state.removeTask(id);
      broadcast('task:dismissed', { id });
      if (wasQueued) {
        broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
      }
      count++;
    }
    res.json({ message: 'Dismissed', count });
  }
});

router.post('/tasks/stop-all', async (req, res) => {
  let aborted = 0;

  // Kill all running processes (executing + planning)
  const activeTaskIds = state.getAllExecutingTaskIds();
  for (const taskId of activeTaskIds) {
    const handle = state.getProcess(taskId);
    if (!handle) continue;

    state.markAborted(taskId);
    const proc = handle.proc || handle;
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    // SIGKILL fallback
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000);
    aborted++;
  }

  // Clear all execution queues
  const dequeuedIds = state.clearAllQueues();
  for (const taskId of dequeuedIds) {
    const task = state.getTask(taskId);
    if (task) {
      broadcast('task:updated', task);
    }
  }

  // Stop autoclicker if running
  try {
    const { stopOrchestrator } = await import('../agents/autoclicker.js');
    stopOrchestrator();
  } catch { /* autoclicker may not be running */ }

  res.json({ message: 'All stopped', aborted, dequeued: dequeuedIds.length });
});

export default router;
