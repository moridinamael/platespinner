import { Router } from 'express';
import { execFile } from 'child_process';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';
import * as state from '../state.js';
import { LOGS_DIR } from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { runGeneration, runExecution, runPlanning, spawnAgent, extractCostData } from '../agents/runner.js';
import { readReplayLog, getReplayMeta } from '../agents/replay.js';
import { buildGenerationCommand } from '../agents/cli.js';
import { emitNotification } from '../notifications.js';

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

router.patch('/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds[] is required' });
  }
  state.reorderTasks(orderedIds);
  broadcast('tasks:reordered', { orderedIds });
  res.json({ message: 'Tasks reordered', count: orderedIds.length });
});

router.patch('/tasks/:id', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'proposed' && task.status !== 'planned' && task.status !== 'failed') {
    return res.status(400).json({ error: `Cannot edit task with status '${task.status}'` });
  }

  const EDITABLE_FIELDS = ['title', 'description', 'rationale', 'effort', 'plan', 'dependencies'];
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

  if (updates.dependencies !== undefined) {
    if (!Array.isArray(updates.dependencies)) {
      return res.status(400).json({ error: 'dependencies must be an array of task IDs' });
    }
    for (const depId of updates.dependencies) {
      if (depId === req.params.id) {
        return res.status(400).json({ error: 'A task cannot depend on itself' });
      }
      const depTask = state.getTask(depId);
      if (!depTask) {
        return res.status(400).json({ error: `Dependency task ${depId} not found` });
      }
      if (depTask.projectId !== task.projectId) {
        return res.status(400).json({ error: 'Cross-project dependencies are not allowed' });
      }
      if (state.wouldCreateCycle(req.params.id, depId)) {
        return res.status(400).json({ error: `Adding dependency ${depId} would create a cycle` });
      }
    }
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
  if (task.status !== 'proposed' && task.status !== 'failed') {
    return res.status(400).json({ error: `Task is ${task.status}, not proposed or failed` });
  }

  if (state.isTaskBlocked(task.id)) {
    const blockers = state.getBlockers(task.id)
      .filter(b => b.status !== 'done')
      .map(b => b.title);
    return res.status(400).json({
      error: 'Task is blocked by unfinished dependencies',
      blockers,
    });
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
  if (task.status !== 'proposed' && task.status !== 'planned' && task.status !== 'failed') {
    return res.status(400).json({ error: `Task is ${task.status}, expected proposed, planned, or failed` });
  }

  if (state.isTaskBlocked(task.id)) {
    const blockers = state.getBlockers(task.id)
      .filter(b => b.status !== 'done')
      .map(b => b.title);
    return res.status(400).json({
      error: 'Task is blocked by unfinished dependencies',
      blockers,
    });
  }

  const { modelId } = req.body || {};

  // Check budget before execution
  const project = state.getProject(task.projectId);
  if (project && project.budgetLimitUsd != null) {
    const projectTasks = state.getTasks(task.projectId);
    const totalSpent = projectTasks.reduce((sum, t) => sum + (t.costUsd || 0), 0);
    if (totalSpent >= project.budgetLimitUsd) {
      emitNotification('budget:exceeded', {
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title,
        totalSpent,
        limit: project.budgetLimitUsd,
      });
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
  // Stop git polling immediately on abort
  if (handle.stopPolling) handle.stopPolling();

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

router.post('/tasks/:id/retry', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'failed') {
    return res.status(400).json({ error: `Task is ${task.status}, not failed` });
  }

  // Reset to 'proposed' to trigger a fresh planning pass with failure context
  // Keep plan, lastTestOutput, failureCount, and agentLog so the next planner/executor has context
  state.updateTask(task.id, {
    status: 'proposed',
    commitHash: null,
    diff: null,
    branch: null,
    baseBranch: null,
    executedBy: null,
  });
  broadcast('task:updated', state.getTask(task.id));

  res.json({ message: 'Task reset for retry', taskId: task.id });
});

router.post('/tasks/:id/dismiss', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Kill running agent subprocess if task is mid-planning or mid-execution
  const handle = state.getProcess(req.params.id);
  if (handle) {
    try { handle.proc.kill('SIGTERM'); } catch { /* already dead */ }
    if (handle.stopPolling) handle.stopPolling();
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

// --- Replay Timeline endpoints ---

router.get('/tasks/:id/replay', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const phases = getReplayMeta(task.id);
  const timeline = [];
  for (const phase of phases) {
    const events = readReplayLog(task.id, phase);
    timeline.push(...events);
  }

  // Also check project-level generation replay
  const genEvents = readReplayLog(task.projectId, 'generation');
  if (genEvents.length > 0) timeline.push(...genEvents);

  // Check project-level judgment replay
  const judgmentEvents = readReplayLog(task.projectId, 'judgment');
  if (judgmentEvents.length > 0) timeline.push(...judgmentEvents);

  // Check project-level testSetup replay
  const testSetupEvents = readReplayLog(task.projectId, 'testSetup');
  if (testSetupEvents.length > 0) timeline.push(...testSetupEvents);

  timeline.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ taskId: task.id, phases, events: timeline });
});

router.get('/tasks/:id/replay/:phase', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const phase = req.params.phase;
  if (!['generation', 'planning', 'execution', 'judgment', 'testSetup'].includes(phase)) {
    return res.status(400).json({ error: 'Invalid phase' });
  }

  const entityId = (phase === 'generation' || phase === 'judgment' || phase === 'testSetup') ? task.projectId : task.id;
  const events = readReplayLog(entityId, phase);
  res.json({ taskId: task.id, phase, events });
});

router.post('/tasks/:id/replay/:phase', async (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const phase = req.params.phase;
  const entityId = (phase === 'generation' || phase === 'judgment' || phase === 'testSetup') ? task.projectId : task.id;
  const events = readReplayLog(entityId, phase);

  const promptEvent = events.find(e => e.type === 'prompt_sent');
  if (!promptEvent) {
    return res.status(404).json({ error: 'No prompt found for this phase' });
  }

  const project = state.getProject(task.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Always use read-only generation command for safety
  const { cmd, args, useStdin } = buildGenerationCommand(promptEvent.modelId, promptEvent.prompt);

  res.json({ message: 'Replay started', phase });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? promptEvent.prompt : null,
      (bytes) => { broadcast('replay:progress', { taskId: task.id, phase, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    broadcast('replay:completed', { taskId: task.id, phase, rawResponse: stdout.slice(0, 100000) });
  } catch (err) {
    broadcast('replay:failed', { taskId: task.id, phase, error: err.message });
  }
});

// --- Dependency info endpoint ---

router.get('/tasks/:id/dependencies', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const dependencies = state.getBlockers(task.id);
  const dependents = state.getDependents(task.id);
  const blocked = state.isTaskBlocked(task.id);

  res.json({ dependencies, dependents, blocked });
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
    const MAX_TASK_FAILURES = 3;
    const validTasks = taskIds
      .map(id => state.getTask(id))
      .filter(t => t && (t.status === 'planned' || t.status === 'proposed' || t.status === 'failed'))
      .filter(t => (t.failureCount || 0) < MAX_TASK_FAILURES)
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    if (validTasks.length === 0) {
      return res.json({ message: 'No tasks to execute', count: 0 });
    }

    let queued = 0;
    let started = 0;
    let skippedBlocked = 0;

    for (const task of validTasks) {
      // Skip blocked tasks
      if (state.isTaskBlocked(task.id)) {
        skippedBlocked++;
        continue;
      }

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

    res.json({ message: 'Batch execution started', count: validTasks.length, started, queued, skippedBlocked });
  } else if (action === 'dismiss') {
    let count = 0;
    for (const id of taskIds) {
      const task = state.getTask(id);
      if (!task) continue;

      const handle = state.getProcess(id);
      if (handle) {
        try { handle.proc.kill('SIGTERM'); } catch { /* already dead */ }
        if (handle.stopPolling) handle.stopPolling();
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
    if (handle.stopPolling) handle.stopPolling();
    try { handle.proc.kill('SIGTERM'); } catch { /* already dead */ }
    // SIGKILL fallback
    setTimeout(() => {
      try { handle.proc.kill('SIGKILL'); } catch { /* already dead */ }
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
