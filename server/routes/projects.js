import { Router } from 'express';
import { execFile } from 'child_process';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { detectTestFramework, runTests } from '../testing.js';
import { runTestSetup } from '../agents/runner.js';
import { MODELS } from '../models.js';

const router = Router();

router.get('/projects', (req, res) => {
  res.json(state.getProjects());
});

router.post('/projects', (req, res) => {
  const { name, path } = req.body;
  if (!path) return res.status(400).json({ error: 'path is required' });

  const project = state.addProject({ name, path: toWSLPath(path) });
  broadcast('project:created', project);
  res.status(201).json(project);
});

router.get('/models', (req, res) => {
  res.json(MODELS);
});

router.patch('/projects/:id', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const updates = {};
  if ('url' in req.body) updates.url = req.body.url || null;
  if ('testCommand' in req.body) updates.testCommand = req.body.testCommand || null;
  const updated = state.updateProject(req.params.id, updates);
  broadcast('project:updated', updated);
  res.json(updated);
});

router.delete('/projects/:id', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  state.removeProject(req.params.id);
  broadcast('project:removed', { id: req.params.id });
  res.status(204).end();
});

// Git push for a project
router.post('/projects/:id/push', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cwd = toWSLPath(project.path);

  execFile('git', ['push'], { cwd }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr.trim() || err.message });
    }
    // stderr often contains the push progress info from git
    const output = (stdout + '\n' + stderr).trim();
    broadcast('project:pushed', { id: project.id, output });
    res.json({ success: true, output });
  });
});

// Git status for a project
router.get('/projects/:id/git-status', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const cwd = toWSLPath(project.path);

  execFile('git', ['log', '--oneline', '-5'], { cwd }, (err, logOut) => {
    execFile('git', ['status', '--porcelain'], { cwd }, (err2, statusOut) => {
      execFile('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd }, (err3, aheadOut) => {
        res.json({
          recentCommits: (logOut || '').trim().split('\n').filter(Boolean),
          uncommittedChanges: (statusOut || '').trim().split('\n').filter(Boolean),
          commitsAhead: parseInt(aheadOut, 10) || 0,
        });
      });
    });
  });
});

// Test info (lightweight, no execution)
router.get('/projects/:id/test-info', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.testCommand) {
    return res.json({ source: 'manual', description: `Manual: ${project.testCommand}` });
  }

  const detected = detectTestFramework(project.path);
  if (detected) {
    return res.json({ source: 'auto', description: `Auto-detected: ${detected.description}` });
  }

  res.json({ source: 'none', description: null });
});

// Run tests
router.post('/projects/:id/test', async (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = await runTests(project);
  broadcast('project:tested', { id: project.id, ...result });
  res.json(result);
});

// Setup tests — spawn agent to create/fix test configuration
router.post('/projects/:id/setup-tests', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (state.isProjectLocked(project.id)) {
    return res.status(409).json({ error: 'Project is busy (another agent is running)' });
  }

  // Build test info to pass as context to the agent
  let testInfo = null;
  if (project.testCommand) {
    testInfo = { source: 'manual', description: `Manual: ${project.testCommand}` };
  } else {
    const detected = detectTestFramework(project.path);
    if (detected) testInfo = { source: 'auto', description: `Auto-detected: ${detected.description}` };
  }

  // Fire and forget — results come via WebSocket
  res.json({ message: 'Test setup started' });

  runTestSetup(project, testInfo).catch((err) => {
    console.error('Test setup failed:', err.message);
  });
});

export default router;
