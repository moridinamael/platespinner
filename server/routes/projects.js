import { Router } from 'express';
import { execFile } from 'child_process';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { detectTestFramework, runTests, validateTestCommand } from '../testing.js';
import { runTestSetup } from '../agents/runner.js';
import { MODELS } from '../models.js';
import { emitNotification } from '../notifications.js';

const RAILWAY_BIN = process.env.RAILWAY_BIN || 'railway';

function execPromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, ...options }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

async function checkRailwayHealth(project) {
  const cwd = toWSLPath(project.path);
  await execPromise(RAILWAY_BIN, ['link', '-p', project.railwayProject, '-e', 'production'], { cwd });
  const statusOut = await execPromise(RAILWAY_BIN, ['status', '--json'], { cwd });
  let statusData;
  try {
    statusData = JSON.parse(statusOut);
  } catch {
    return { healthy: true, message: 'Railway project linked — no deployment data available', timestamp: Date.now() };
  }
  const envEdges = statusData.environments?.edges || [];
  const serviceInstances = envEdges.flatMap(e =>
    (e.node?.serviceInstances?.edges || []).map(si => si.node)
  );
  const failed = serviceInstances.filter(si => {
    const st = (si.latestDeployment?.status || '').toUpperCase();
    return st === 'FAILED' || st === 'CRASHED' || st === 'ERROR';
  });
  if (failed.length === 0) {
    return { healthy: true, message: 'All services healthy', timestamp: Date.now() };
  }
  const failedNames = failed.map(s => s.serviceName || 'unknown').join(', ');
  return { healthy: false, message: `Deployment failed (${failedNames})`, failedNames, timestamp: Date.now() };
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

router.patch('/projects/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array' });
  }
  state.reorderProjects(orderedIds);
  broadcast('projects:reordered', { orderedIds });
  res.json({ success: true });
});

router.patch('/projects/:id', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const updates = {};
  if ('url' in req.body) updates.url = req.body.url || null;
  if ('testCommand' in req.body) {
    const cmd = req.body.testCommand || null;
    if (cmd) {
      const check = validateTestCommand(cmd);
      if (!check.valid) return res.status(400).json({ error: check.reason });
    }
    updates.testCommand = cmd;
  }
  if ('railwayProject' in req.body) updates.railwayProject = req.body.railwayProject || null;
  if ('autoTestOnCommit' in req.body) updates.autoTestOnCommit = !!req.body.autoTestOnCommit;
  if ('branchStrategy' in req.body) {
    const strategy = req.body.branchStrategy;
    if (!['direct', 'per-task', 'per-batch'].includes(strategy)) {
      return res.status(400).json({ error: 'branchStrategy must be direct, per-task, or per-batch' });
    }
    updates.branchStrategy = strategy;
  }
  if ('budgetLimitUsd' in req.body) {
    const val = req.body.budgetLimitUsd;
    updates.budgetLimitUsd = (val === null || val === '') ? null : Number(val);
  }
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

    // Auto-test after push if enabled
    if (project.autoTestOnCommit) {
      broadcast('project:test-started', { projectId: project.id });
      runTests(project).then((testResult) => {
        state.updateProject(project.id, { lastTestResult: { passed: testResult.passed, summary: testResult.summary, output: testResult.output, timestamp: Date.now() } });
        broadcast('project:test-completed', { projectId: project.id, passed: testResult.passed, summary: testResult.summary, output: testResult.output });
      }).catch((err) => {
        state.updateProject(project.id, { lastTestResult: { passed: false, summary: err.message || 'Auto-test failed', output: '', timestamp: Date.now() } });
        broadcast('project:test-completed', { projectId: project.id, passed: false, summary: err.message || 'Auto-test failed', output: '' });
      });
    }

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

// Cached last test result (no re-run)
router.get('/projects/:id/last-test-result', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project.lastTestResult || null);
});

// Run tests (async — results broadcast via WebSocket)
router.post('/projects/:id/test', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  res.status(202).json({ status: 'running' });
  broadcast('project:test-started', { projectId: project.id });

  runTests(project)
    .then((result) => {
      state.updateProject(project.id, { lastTestResult: { passed: result.passed, summary: result.summary, output: result.output, timestamp: Date.now() } });
      broadcast('project:test-completed', {
        projectId: project.id,
        passed: result.passed,
        summary: result.summary,
        output: result.output,
      });
      if (!result.passed) {
        emitNotification('test:failure', {
          projectId: project.id,
          summary: result.summary,
        });
      }
    })
    .catch((err) => {
      state.updateProject(project.id, { lastTestResult: { passed: false, summary: err.message || 'Test execution error', output: '', timestamp: Date.now() } });
      broadcast('project:test-completed', {
        projectId: project.id,
        passed: false,
        summary: err.message || 'Test execution error',
        output: '',
      });
      emitNotification('test:failure', {
        projectId: project.id,
        summary: err.message || 'Test execution error',
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

  broadcast('project:railway-checking', { projectId: project.id });

  try {
    const result = await checkRailwayHealth(project);
    const railwayResult = { healthy: result.healthy, message: result.message, timestamp: result.timestamp };
    state.updateProject(req.params.id, { lastRailwayResult: railwayResult });
    broadcast('project:railway-status', { projectId: project.id, ...railwayResult });

    if (!result.healthy) {
      // Fetch build logs and create fix task (only on manual check)
      const cwd = toWSLPath(project.path);
      let buildLogs = '';
      try {
        buildLogs = await execPromise(RAILWAY_BIN, ['logs', '--build', '--lines', '100', '--latest'], { cwd });
      } catch (logErr) {
        buildLogs = `(Could not fetch build logs: ${logErr.message})`;
      }
      const truncatedLogs = buildLogs.slice(0, 5000);
      const description = `## Railway Deployment Failed\nFailed services: ${result.failedNames}\n\n## Build Logs\n\`\`\`\n${truncatedLogs}\n\`\`\``;
      const task = state.addTask({
        projectId: req.params.id,
        title: `Fix failed Railway deployment (${result.failedNames})`,
        description,
        rationale: 'Automated: Railway deployment failed — investigate build logs and fix the issue',
        effort: 'medium',
      });
      broadcast('task:created', task);
      railwayResult.taskId = task.id;
      railwayResult.message = `${result.message} — task created`;
      state.updateProject(req.params.id, { lastRailwayResult: railwayResult });
    }

    return res.json(railwayResult);
  } catch (err) {
    const failResult = { healthy: false, message: err.message, timestamp: Date.now() };
    broadcast('project:railway-status', { projectId: project.id, ...failResult });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/costs', (req, res) => {
  const project = state.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const summary = state.getProjectCostSummary(req.params.id);
  summary.budgetLimitUsd = project.budgetLimitUsd;
  res.json(summary);
});

router.get('/costs/summary', (req, res) => {
  const allProjects = state.getProjects();
  const summaries = allProjects.map(p => ({
    projectId: p.id,
    projectName: p.name,
    budgetLimitUsd: p.budgetLimitUsd,
    ...state.getProjectCostSummary(p.id),
  }));
  const grandTotal = summaries.reduce((sum, s) => sum + s.totalCost, 0);
  res.json({ grandTotal, projects: summaries });
});

// Merge a task's feature branch back to its base branch
router.post('/projects/:projectId/tasks/:taskId/merge', async (req, res) => {
  const project = state.getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const task = state.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.branch) return res.status(400).json({ error: 'Task has no feature branch' });

  const cwd = toWSLPath(project.path);
  const strategy = req.body.strategy || 'merge';
  const targetBranch = task.baseBranch || 'main';

  try {
    // Checkout the target branch
    await execPromise('git', ['checkout', targetBranch], { cwd });

    if (strategy === 'squash') {
      await execPromise('git', ['merge', '--squash', task.branch], { cwd });
      await execPromise('git', ['commit', '-m', `squash: ${task.title} (${task.branch})`], { cwd });
    } else {
      await execPromise('git', ['merge', '--no-ff', task.branch, '-m', `merge: ${task.title} (${task.branch})`], { cwd });
    }

    // Delete the feature branch after successful merge
    try {
      await execPromise('git', ['branch', '-d', task.branch], { cwd });
    } catch { /* branch deletion is best-effort */ }

    state.updateTask(task.id, { merged: true, branch: null });
    broadcast('task:updated', state.getTask(task.id));

    res.json({ message: `Branch ${task.branch} merged via ${strategy}` });
  } catch (err) {
    // Abort merge if there was a conflict
    try {
      await execPromise('git', ['merge', '--abort'], { cwd });
    } catch { /* ignore if no merge to abort */ }
    // Try to return to the target branch
    try {
      await execPromise('git', ['checkout', targetBranch], { cwd });
    } catch { /* ignore */ }
    res.status(500).json({ error: `Merge failed: ${err.message}` });
  }
});

// Revert a task's commit
router.post('/projects/:projectId/tasks/:taskId/revert', async (req, res) => {
  const project = state.getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const task = state.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.commitHash) return res.status(400).json({ error: 'Task has no commit hash' });

  const cwd = toWSLPath(project.path);

  try {
    await execPromise('git', ['revert', '--no-edit', task.commitHash], { cwd });
    const revertMsg = `Reverted commit ${task.commitHash.slice(0, 7)}`;
    state.updateTask(task.id, { reverted: true });
    broadcast('task:updated', state.getTask(task.id));
    res.json({ message: revertMsg });
  } catch (err) {
    // Abort revert if it failed (e.g., conflicts)
    try {
      await execPromise('git', ['revert', '--abort'], { cwd });
    } catch { /* ignore */ }
    res.status(500).json({ error: `Revert failed: ${err.message}` });
  }
});

// Create a PR from a task's feature branch
router.post('/projects/:projectId/tasks/:taskId/create-pr', async (req, res) => {
  const project = state.getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const task = state.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.branch) return res.status(400).json({ error: 'Task has no feature branch' });

  const cwd = toWSLPath(project.path);

  try {
    // Push branch to remote
    await execPromise('git', ['push', '-u', 'origin', task.branch], { cwd, timeout: 60000 });

    // Create PR using gh CLI
    const prBody = `## ${task.title}\n\n${task.description || ''}\n\n${task.rationale ? `**Rationale:** ${task.rationale}` : ''}`;
    const prOutput = await execPromise('gh', [
      'pr', 'create',
      '--head', task.branch,
      '--title', task.title,
      '--body', prBody,
    ], { cwd, timeout: 30000 });

    const prUrl = prOutput.trim();
    state.updateTask(task.id, { prUrl });
    broadcast('task:updated', state.getTask(task.id));

    res.json({ prUrl });
  } catch (err) {
    res.status(500).json({ error: `PR creation failed: ${err.message}` });
  }
});

export { checkRailwayHealth };
export default router;
