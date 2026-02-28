import { Router } from 'express';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { runGeneration, runExecution, runPlanning } from '../agents/runner.js';

const router = Router();

router.get('/tasks', (req, res) => {
  const { projectId } = req.query;
  res.json(state.getTasks(projectId));
});

router.post('/generate', async (req, res) => {
  const { projectId, templateId, modelId } = req.body;
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
    projects.map((p) => runGeneration(p, templateId, modelId))
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

  if (state.isProjectLocked(task.projectId)) {
    return res.status(409).json({ error: 'Another task is already executing for this project' });
  }

  const { modelId } = req.body || {};

  // Fire and forget — results come via WebSocket
  res.json({ message: 'Execution started', taskId: task.id });

  try {
    await runExecution(task, modelId);
  } catch (err) {
    console.error('Execution failed:', err.message);
  }
});

router.post('/tasks/:id/dismiss', (req, res) => {
  const task = state.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  state.removeTask(req.params.id);
  broadcast('task:dismissed', { id: req.params.id });
  res.status(204).end();
});

export default router;
