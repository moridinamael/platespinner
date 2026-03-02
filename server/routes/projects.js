import { Router } from 'express';
import { execFile } from 'child_process';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { detectTestFramework, runTests } from '../testing.js';
import { runTestSetup } from '../agents/runner.js';
import { MODELS } from '../models.js';

const RAILWAY_BIN = process.env.RAILWAY_BIN || 'railway';

function execPromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, ...options }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

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
  if ('railwayProject' in req.body) updates.railwayProject = req.body.railwayProject || null;
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

// Run tests (async — results broadcast via WebSocket)
router.post('/projects/:id/test', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  res.status(202).json({ status: 'running' });
  broadcast('project:test-started', { projectId: project.id });

  runTests(project)
    .then((result) => {
      broadcast('project:test-completed', {
        projectId: project.id,
        passed: result.passed,
        summary: result.summary,
        output: result.output,
      });
    })
    .catch((err) => {
      broadcast('project:test-completed', {
        projectId: project.id,
        passed: false,
        summary: err.message || 'Test execution error',
        output: '',
      });
    });
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

// Create a fix-tests task from failing test output
router.post('/projects/:id/fix-tests', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { summary, output } = req.body;
  const truncatedOutput = output ? output.slice(0, 5000) : '';
  const description = `## Test Failure Summary\n${summary || 'Tests are failing.'}\n\n## Test Output\n\`\`\`\n${truncatedOutput}\n\`\`\``;

  const task = state.addTask({
    projectId: req.params.id,
    title: 'Fix failing tests',
    description,
    rationale: 'Automated: tests are failing and need to be fixed — either fix the code or update incompatible tests',
    effort: 'medium',
  });
  broadcast('task:created', task);
  res.status(201).json(task);
});

// Check Railway deployment status
router.post('/projects/:id/check-railway', async (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.railwayProject) return res.status(400).json({ error: 'No Railway project configured' });

  const cwd = toWSLPath(project.path);

  try {
    // Link to the Railway project
    await execPromise(RAILWAY_BIN, ['link', '-p', project.railwayProject, '-e', 'production'], { cwd });

    // Get deployment status
    const statusOut = await execPromise(RAILWAY_BIN, ['status', '--json'], { cwd });
    let statusData;
    try {
      statusData = JSON.parse(statusOut);
    } catch {
      return res.json({ healthy: true, message: 'Railway project linked — no deployment data available' });
    }

    // Extract service instances from GraphQL-style edges/nodes structure
    const envEdges = statusData.environments?.edges || [];
    const serviceInstances = envEdges.flatMap(e =>
      (e.node?.serviceInstances?.edges || []).map(si => si.node)
    );

    // Check for failures in latestDeployment status
    const failed = serviceInstances.filter(si => {
      const st = (si.latestDeployment?.status || '').toUpperCase();
      return st === 'FAILED' || st === 'CRASHED' || st === 'ERROR';
    });

    if (failed.length === 0) {
      return res.json({ healthy: true, message: 'All services healthy' });
    }

    // Fetch build logs for failed deployment
    let buildLogs = '';
    try {
      buildLogs = await execPromise(RAILWAY_BIN, ['logs', '--build', '--lines', '100', '--latest'], { cwd });
    } catch (logErr) {
      buildLogs = `(Could not fetch build logs: ${logErr.message})`;
    }

    const failedNames = failed.map(s => s.serviceName || 'unknown').join(', ');
    const truncatedLogs = buildLogs.slice(0, 5000);
    const description = `## Railway Deployment Failed\nFailed services: ${failedNames}\n\n## Build Logs\n\`\`\`\n${truncatedLogs}\n\`\`\``;

    const task = state.addTask({
      projectId: req.params.id,
      title: `Fix failed Railway deployment (${failedNames})`,
      description,
      rationale: 'Automated: Railway deployment failed — investigate build logs and fix the issue',
      effort: 'medium',
    });
    broadcast('task:created', task);

    return res.json({ healthy: false, message: `Deployment failed (${failedNames}) — task created`, taskId: task.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
