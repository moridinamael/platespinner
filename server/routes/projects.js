import { Router } from 'express';
import { execFile } from 'child_process';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { toWSLPath } from '../paths.js';
import { detectTestFramework, runTests, validateTestCommand } from '../testing.js';
import { runTestSetup, runRanking } from '../agents/runner.js';
import { MODELS } from '../models.js';
import { emitNotification } from '../notifications.js';
import { renderPRBody } from '../prUtils.js';
import { trackPR, untrackPR, fetchPRStatus } from '../prStatus.js';
import { isValidUUID, validateStringField, validateBody } from '../validation.js';

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

router.param('id', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid project ID format: expected a UUID' });
  }
  const project = state.getProject(value);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  req.project = project;
  next();
});

router.param('projectId', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid project ID format: expected a UUID' });
  }
  const project = state.getProject(value);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  req.project = project;
  next();
});

router.param('taskId', (req, res, next, value) => {
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid task ID format: expected a UUID' });
  }
  const task = state.getTask(value);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  req.task = task;
  next();
});

router.get('/projects', (req, res) => {
  res.json(state.getProjects());
});

router.post('/projects', validateBody({
  name: { type: 'string', maxLength: 200 },
  path: { type: 'string', required: true, maxLength: 500 },
}), (req, res) => {
  const project = state.addProject({ name: req.body.name, path: toWSLPath(req.body.path) });
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
  const invalidId = orderedIds.find(id => !isValidUUID(id));
  if (invalidId) {
    return res.status(400).json({ error: `Invalid project ID format: ${invalidId}` });
  }
  state.reorderProjects(orderedIds);
  broadcast('projects:reordered', { orderedIds });
  res.json({ success: true });
});

router.patch('/projects/:id', (req, res) => {
  const project = req.project;
  const updates = {};
  if ('url' in req.body && req.body.url) {
    const err = validateStringField(req.body.url, 'url', { maxLength: 2000 });
    if (err) return res.status(400).json({ error: err });
  }
  if ('railwayProject' in req.body && req.body.railwayProject) {
    const err = validateStringField(req.body.railwayProject, 'railwayProject', { maxLength: 200 });
    if (err) return res.status(400).json({ error: err });
  }
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
    if (updates.budgetLimitUsd !== null && isNaN(updates.budgetLimitUsd)) {
      return res.status(400).json({ error: 'budgetLimitUsd must be a number' });
    }
  }
  if ('autoCreatePR' in req.body) updates.autoCreatePR = !!req.body.autoCreatePR;
  if ('prTemplate' in req.body) updates.prTemplate = req.body.prTemplate || null;
  if ('prReviewers' in req.body) updates.prReviewers = req.body.prReviewers || null;
  if ('prBaseBranch' in req.body) updates.prBaseBranch = req.body.prBaseBranch || null;
  const updated = state.updateProject(req.params.id, updates);
  broadcast('project:updated', updated);
  res.json(updated);
});

router.delete('/projects/:id', (req, res) => {
  state.removeProject(req.params.id);
  broadcast('project:removed', { id: req.params.id });
  res.status(204).end();
});

// Git push for a project
router.post('/projects/:id/push', (req, res) => {
  const project = req.project;
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
  const project = req.project;
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
  const project = req.project;
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
  res.json(req.project.lastTestResult || null);
});

// Run tests (async — results broadcast via WebSocket)
router.post('/projects/:id/test', (req, res) => {
  const project = req.project;
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
  const project = req.project;
  if (!state.lockProject(project.id)) {
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

  // Fire and forget — lock already held, results come via WebSocket
  res.json({ message: 'Test setup started' });

  runTestSetup(project, testInfo, { lockHeld: true }).catch((err) => {
    console.error('Test setup failed:', err.message);
  });
});

// Create a fix-tests task from failing test output
router.post('/projects/:id/fix-tests', (req, res) => {
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
  const project = req.project;
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
  const summary = state.getProjectCostSummary(req.params.id);
  summary.budgetLimitUsd = req.project.budgetLimitUsd;
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

// Analytics dashboard data
router.get('/analytics', (req, res) => {
  const projectId = req.query.projectId || null;
  const analytics = state.getAnalyticsData(projectId);

  // Add autoclicker metrics
  const auditLog = state.getAuditLog(500);
  const filteredLog = projectId
    ? auditLog.filter(e => e.projectId === projectId)
    : auditLog;

  const autoclickerActions = { propose: 0, plan: 0, execute: 0, skip: 0 };
  let autoclickerTotalCost = 0;
  for (const entry of filteredLog) {
    autoclickerActions[entry.action] = (autoclickerActions[entry.action] || 0) + 1;
    autoclickerTotalCost += entry.costUsd || 0;
  }
  const totalCycles = Object.values(autoclickerActions).reduce((s, v) => s + v, 0);
  const actionfulCycles = totalCycles - autoclickerActions.skip;

  const projectMap = {};
  for (const p of state.getProjects()) {
    projectMap[p.id] = p.name;
  }

  analytics.autoclicker = {
    actions: autoclickerActions,
    totalCycles,
    actionfulCycles,
    totalCost: autoclickerTotalCost,
    costPerAction: actionfulCycles > 0 ? autoclickerTotalCost / actionfulCycles : 0,
    recentDecisions: filteredLog.slice(-20),
  };
  analytics.projectMap = projectMap;

  res.json(analytics);
});

// Merge a task's feature branch back to its base branch
router.post('/projects/:projectId/tasks/:taskId/merge',
  validateBody({ strategy: { type: 'string', enum: ['merge', 'squash'] } }),
  async (req, res) => {
  const project = req.project;
  const task = req.task;
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
  const project = req.project;
  const task = req.task;
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
  const project = req.project;
  const task = req.task;
  if (!task.branch) return res.status(400).json({ error: 'Task has no feature branch' });

  const cwd = toWSLPath(project.path);

  try {
    // Push branch to remote
    await execPromise('git', ['push', '-u', 'origin', task.branch], { cwd, timeout: 60000 });

    // Build PR body from project template or default
    const prBody = renderPRBody(project.prTemplate, task);

    const prArgs = [
      'pr', 'create',
      '--head', task.branch,
      '--title', task.title,
      '--body', prBody,
    ];
    if (project.prBaseBranch) prArgs.push('--base', project.prBaseBranch);
    if (project.prReviewers) prArgs.push('--reviewer', project.prReviewers);

    let prUrl;
    try {
      const prOutput = await execPromise('gh', prArgs, { cwd, timeout: 30000 });
      prUrl = prOutput.trim();
    } catch (createErr) {
      // Handle "already exists" — find existing PR
      if (createErr.message && createErr.message.includes('already exists')) {
        const viewOutput = await execPromise('gh', ['pr', 'view', task.branch, '--json', 'url,number'], { cwd, timeout: 15000 });
        const viewData = JSON.parse(viewOutput.trim());
        prUrl = viewData.url;
        const prNumber = viewData.number;
        state.updateTask(task.id, { prUrl, prNumber });
        broadcast('task:updated', state.getTask(task.id));
        if (prNumber) {
          trackPR(task.id, project.id, prNumber);
          try {
            const prStatus = await fetchPRStatus(project.path, prNumber);
            state.updateTask(task.id, { prStatus });
            broadcast('task:pr-status', { taskId: task.id, prStatus });
          } catch { /* best-effort */ }
        }
        return res.json({ prUrl });
      }
      throw createErr;
    }

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]) : null;

    state.updateTask(task.id, { prUrl, prNumber });
    broadcast('task:updated', state.getTask(task.id));

    // Track for status polling and fetch initial status
    if (prNumber) {
      trackPR(task.id, project.id, prNumber);
      try {
        const prStatus = await fetchPRStatus(project.path, prNumber);
        state.updateTask(task.id, { prStatus });
        broadcast('task:pr-status', { taskId: task.id, prStatus });
      } catch { /* initial status fetch is best-effort */ }
    }

    res.json({ prUrl });
  } catch (err) {
    res.status(500).json({ error: `PR creation failed: ${err.message}` });
  }
});

// Merge a PR via GitHub (respects branch protections)
router.post('/projects/:projectId/tasks/:taskId/merge-pr', async (req, res) => {
  const project = req.project;
  const task = req.task;
  if (!task.prNumber) return res.status(400).json({ error: 'Task has no PR' });

  const cwd = toWSLPath(project.path);
  const strategy = req.body.strategy || 'merge';
  const strategyFlag = strategy === 'squash' ? '--squash' : strategy === 'rebase' ? '--rebase' : '--merge';

  try {
    await execPromise('gh', [
      'pr', 'merge', String(task.prNumber),
      strategyFlag, '--delete-branch'
    ], { cwd, timeout: 30000 });

    state.updateTask(task.id, {
      merged: true,
      prStatus: { ...task.prStatus, state: 'MERGED', updatedAt: Date.now() },
    });
    untrackPR(task.id);
    broadcast('task:updated', state.getTask(task.id));

    res.json({ message: `PR #${task.prNumber} merged via ${strategy}` });
  } catch (err) {
    res.status(500).json({ error: `PR merge failed: ${err.message}` });
  }
});

// Rank proposed tasks using an LLM agent
router.post('/projects/:id/rank-proposals',
  validateBody({ modelId: { type: 'string' } }),
  async (req, res) => {
    const project = req.project;
    const proposedTasks = state.getTasks(project.id).filter(t => t.status === 'proposed');

    if (proposedTasks.length === 0) {
      return res.status(400).json({ error: 'No proposed tasks to rank' });
    }

    const { modelId } = req.body || {};

    // Fire and forget — results come via WebSocket
    res.json({
      message: 'Ranking started',
      projectId: project.id,
      taskCount: proposedTasks.length,
    });

    try {
      await runRanking(project, modelId);
    } catch (err) {
      console.error('Ranking failed:', err.message);
    }
  }
);

export { checkRailwayHealth };
export default router;
