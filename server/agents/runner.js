import { spawn, execFile, execFileSync } from 'child_process';
import { createWriteStream, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { broadcast } from '../ws.js';
import { buildGenerationCommand, buildExecutionCommand, buildTestSetupCommand } from './cli.js';
import { buildGenerationPrompt, buildExecutionPrompt, buildPlanningPrompt, buildTestSetupPrompt, buildJudgmentPrompt, getBuiltInTemplates } from './prompts.js';
import { parseGenerationOutput, parseExecutionOutput, parsePlanningOutput, parseTestSetupOutput, parseJudgmentOutput, extractClaudeJsonOutput, estimateTokensFromText } from './parser.js';
import { toWSLPath } from '../paths.js';
import { DEFAULT_MODEL_ID, getModel, estimateCost } from '../models.js';
import { runTests, validateTestCommand } from '../testing.js';
import * as state from '../state.js';
import { LOGS_DIR } from '../state.js';
import { registerAgent, unregisterAgent } from '../census.js';
import { emitNotification, checkAllTasksDone } from '../notifications.js';

const TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// --- Log file helpers ---

function createLogStream(taskId, phase) {
  mkdirSync(LOGS_DIR, { recursive: true });
  const filename = `${taskId}-${phase}.log`;
  const filePath = join(LOGS_DIR, filename);
  const stream = createWriteStream(filePath, { flags: 'a' });
  return { stream, filePath, filename };
}

// --- Git branch helpers ---

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

async function getCurrentBranch(cwd) {
  return gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

async function branchExists(cwd, branchName) {
  try {
    await gitExec(['rev-parse', '--verify', branchName], cwd);
    return true;
  } catch {
    return false;
  }
}

function advanceQueue(projectId) {
  let nextTaskId;
  while ((nextTaskId = state.dequeueTask(projectId))) {
    const nextTask = state.getTask(nextTaskId);
    if (nextTask && nextTask.status === 'queued') {
      broadcast('execution:queue-advanced', {
        projectId,
        startedTaskId: nextTaskId,
        queue: state.getQueue(projectId),
      });
      broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
      runExecution(nextTask, nextTask.executedBy).catch((advanceErr) => {
        console.error('Queue auto-advance failed:', advanceErr.message);
        const staleTask = state.getTask(nextTaskId);
        if (staleTask && staleTask.status === 'queued') {
          state.updateTask(nextTaskId, {
            status: staleTask.plan ? 'planned' : 'proposed',
            agentLog: `Auto-advance failed: ${advanceErr.message}`,
          });
          broadcast('execution:failed', {
            taskId: nextTaskId,
            error: `Auto-advance failed: ${advanceErr.message}`,
            aborted: false,
            status: staleTask.plan ? 'planned' : 'proposed',
          });
        }
      });
      return;
    }
    // Task was dismissed/deleted or status changed — skip it, try next
  }
  // Queue is empty — broadcast so clients clear stale state
  broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
}

const GIT_POLL_MS = 10_000; // poll git status every 10s

function pollGitStatus(cwd, taskId) {
  const interval = setInterval(() => {
    // Get short diff stat
    execFile('git', ['diff', '--stat', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) return;
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return;
      // Last line is summary like " 3 files changed, 45 insertions(+), 12 deletions(-)"
      const summary = lines[lines.length - 1].trim();
      // Individual file changes
      const files = lines.slice(0, -1).map((l) => l.trim()).filter(Boolean);
      broadcast('execution:git', { taskId, summary, files });
    });

    // Also check for new untracked files
    execFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd }, (err, stdout) => {
      if (err || !stdout.trim()) return;
      const untracked = stdout.trim().split('\n').filter(Boolean);
      if (untracked.length > 0) {
        broadcast('execution:git-untracked', { taskId, files: untracked });
      }
    });
  }, GIT_POLL_MS);

  return () => clearInterval(interval);
}

// Get full login-shell PATH (includes ~/.bashrc, Windows PATH in WSL, etc.)
let _loginPath;
function getLoginPath() {
  if (_loginPath !== undefined) return _loginPath;
  try {
    _loginPath = execFileSync('bash', ['-lc', 'echo $PATH'], { timeout: 5000 }).toString().trim();
  } catch {
    _loginPath = null;
  }
  return _loginPath;
}

// Extra tool directories that may not be in shell configs
const HOME = homedir();
const EXTRA_PATH_DIRS = [
  `${HOME}/go/bin`,
  `${HOME}/.cargo/bin`,
  `${HOME}/.local/bin`,
  `${HOME}/.npm-global/bin`,
].join(':');

// Clean env: remove CLAUDECODE to allow nested sessions, merge login PATH + extra dirs
function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const loginPath = getLoginPath();
  const basePath = loginPath || env.PATH || '';
  env.PATH = `${EXTRA_PATH_DIRS}:${basePath}`;
  return env;
}

function spawnAgent(cmd, args, cwd, stdinData, onProgress, logStream) {
  cwd = toWSLPath(cwd);
  let stdout = '';
  let stderr = '';

  const proc = spawn(cmd, args, {
    cwd,
    env: cleanEnv(),
  });

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Agent timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    // Pipe prompt via stdin if provided
    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (logStream) logStream.write(chunk);
      if (onProgress) onProgress(stdout.length, text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (logStream) logStream.write(chunk);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (logStream) logStream.end();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Agent exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (logStream) logStream.end();
      reject(err);
    });
  });

  return { proc, promise };
}

function resolveTemplateContent(templateId) {
  if (!templateId) return undefined;
  // Check built-ins
  const builtIn = getBuiltInTemplates().find((t) => t.id === templateId);
  if (builtIn) return builtIn.content;
  // Check custom templates
  const custom = state.getPromptTemplate(templateId);
  if (custom) return custom.content;
  return undefined;
}

function extractCostData(stdout, stdinData, modelId) {
  const model = getModel(modelId);
  if (model?.provider === 'claude') {
    const extracted = extractClaudeJsonOutput(stdout);
    return {
      agentText: extracted.text,
      costUsd: extracted.costUsd,
      inputTokens: extracted.inputTokens,
      outputTokens: extracted.outputTokens,
      durationMs: extracted.durationMs,
      numTurns: extracted.numTurns,
    };
  }
  // Non-Claude: estimate from character counts
  const inputTokens = estimateTokensFromText(stdinData || '');
  const outputTokens = estimateTokensFromText(stdout);
  const costUsd = estimateCost(modelId, inputTokens, outputTokens);
  return {
    agentText: stdout,
    costUsd,
    inputTokens,
    outputTokens,
    durationMs: null,
    numTurns: null,
  };
}

function checkBudget(project) {
  if (project.budgetLimitUsd == null) return { allowed: true };
  const projectTasks = state.getTasks(project.id);
  const totalSpent = projectTasks.reduce((sum, t) => sum + (t.costUsd || 0), 0);
  if (totalSpent >= project.budgetLimitUsd) {
    return { allowed: false, totalSpent, limit: project.budgetLimitUsd };
  }
  return { allowed: true, totalSpent, limit: project.budgetLimitUsd, remaining: project.budgetLimitUsd - totalSpent };
}

export async function runGeneration(project, templateId, modelId, promptContent) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const skillContent = promptContent || resolveTemplateContent(templateId);
  const prompt = buildGenerationPrompt(project.path, skillContent);
  const { cmd, args, useStdin } = buildGenerationCommand(modelId, prompt);

  broadcast('generation:started', { projectId: project.id });
  const agentId = registerAgent({ type: 'generating', projectId: project.id, modelId });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? prompt : null,
      (bytes) => { broadcast('generation:progress', { projectId: project.id, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const proposals = parseGenerationOutput(costData.agentText);

    // Dedup: skip proposals whose title matches an existing task for this project
    const existingTitles = new Set(
      state.getTasks(project.id).map((t) => t.title.toLowerCase().trim())
    );

    const costPerTask = costData.costUsd ? costData.costUsd / Math.max(proposals.length, 1) : null;

    const createdTasks = [];
    let skipped = 0;
    for (const proposal of proposals) {
      if (existingTitles.has(proposal.title.toLowerCase().trim())) {
        skipped++;
        continue;
      }
      const task = state.addTask({
        projectId: project.id,
        title: proposal.title,
        description: proposal.description,
        rationale: proposal.rationale,
        effort: proposal.estimatedEffort || 'medium',
        generatedBy: modelId,
      });
      if (costPerTask != null) {
        state.updateTask(task.id, {
          tokenUsage: { generation: { input: costData.inputTokens, output: costData.outputTokens } },
          costUsd: costPerTask,
        });
      }
      createdTasks.push(task);
      broadcast('task:created', task);
    }

    broadcast('generation:completed', {
      projectId: project.id,
      taskCount: createdTasks.length,
      skippedDuplicates: skipped,
      costUsd: costData.costUsd,
    });

    return createdTasks;
  } catch (err) {
    broadcast('generation:failed', {
      projectId: project.id,
      error: err.message,
    });
    throw err;
  } finally {
    unregisterAgent(agentId);
  }
}

export async function runPlanning(task, modelId) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const project = state.getProject(task.projectId);
  if (!project) throw new Error('Project not found');

  const prompt = buildPlanningPrompt(task);
  const { cmd, args, useStdin } = buildGenerationCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'planning' });
  broadcast('planning:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'planning', projectId: project.id, taskId: task.id, modelId });

  const { stream: logStream } = createLogStream(task.id, 'planning');

  const { proc, promise } = spawnAgent(
    cmd, args, project.path,
    useStdin ? prompt : null,
    (bytes, textChunk) => {
      broadcast('planning:progress', { taskId: task.id, bytesReceived: bytes });
      if (textChunk) broadcast('log:chunk', { taskId: task.id, phase: 'planning', chunk: textChunk });
    },
    logStream
  );
  state.setProcess(task.id, proc);

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const plan = parsePlanningOutput(costData.agentText);

    const planningCost = costData.costUsd || 0;
    const existingCost = task.costUsd || 0;
    const updated = state.updateTask(task.id, {
      status: 'planned',
      plan,
      plannedBy: modelId,
      tokenUsage: {
        ...(task.tokenUsage || {}),
        planning: { input: costData.inputTokens, output: costData.outputTokens },
      },
      costUsd: existingCost + planningCost,
    });
    broadcast('planning:completed', { taskId: task.id, plan, plannedBy: modelId, costUsd: planningCost });

    return updated;
  } catch (err) {
    // Task may have been dismissed while planning — skip updates if removed
    if (state.getTask(task.id)) {
      state.updateTask(task.id, { status: 'proposed', agentLog: err.message });
      broadcast('planning:failed', { taskId: task.id, error: err.message });
      emitNotification('task:failed', {
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title,
        error: err.message,
        phase: 'planning',
      });
    }
    throw err;
  } finally {
    logStream.end();
    state.removeProcess(task.id);
    unregisterAgent(agentId);
  }
}

export async function runExecution(task, modelId) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const project = state.getProject(task.projectId);
  if (!project) throw new Error('Project not found');

  if (!state.lockProject(project.id)) {
    throw new Error('Project is already being executed on');
  }

  const budget = checkBudget(project);
  if (!budget.allowed) {
    state.unlockProject(project.id);
    throw new Error(`Budget limit exceeded: $${budget.totalSpent.toFixed(2)} spent of $${budget.limit.toFixed(2)} limit`);
  }

  // --- Per-task branch creation ---
  const cwd = toWSLPath(project.path);
  let branchName = null;
  let baseBranch = null;

  if (project.branchStrategy === 'per-task') {
    baseBranch = await getCurrentBranch(cwd);
    const slug = slugify(task.title);
    branchName = `kanban/task-${task.id.slice(0, 8)}-${slug}`;

    // Handle branch already existing (retry scenario)
    if (await branchExists(cwd, branchName)) {
      await gitExec(['checkout', branchName], cwd);
    } else {
      await gitExec(['checkout', '-b', branchName], cwd);
    }

    state.updateTask(task.id, { branch: branchName, baseBranch });
    broadcast('task:updated', state.getTask(task.id));
  }

  // Capture HEAD before execution so we can diff afterwards
  let preCommitHash;
  try {
    preCommitHash = await gitExec(['rev-parse', 'HEAD'], cwd);
  } catch {
    preCommitHash = null;
  }

  const prompt = buildExecutionPrompt(task);
  const { cmd, args, useStdin } = buildExecutionCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'executing', executedBy: modelId });
  broadcast('execution:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'executing', projectId: project.id, taskId: task.id, modelId });

  const stopPolling = pollGitStatus(cwd, task.id);
  const { stream: logStream } = createLogStream(task.id, 'execution');

  const { proc, promise } = spawnAgent(
    cmd, args, project.path,
    useStdin ? prompt : null,
    (bytes, textChunk) => {
      broadcast('execution:progress', { taskId: task.id, bytesReceived: bytes });
      if (textChunk) broadcast('log:chunk', { taskId: task.id, phase: 'execution', chunk: textChunk });
    },
    logStream
  );

  state.setProcess(task.id, { proc, stopPolling });

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const result = parseExecutionOutput(costData.agentText);

    // Capture diff between pre-execution HEAD and post-execution state
    let diff = null;
    if (preCommitHash) {
      try {
        const postRef = result.commitHash || 'HEAD';
        diff = await new Promise((resolve, reject) => {
          execFile('git', ['diff', `${preCommitHash}..${postRef}`], { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
          });
        });
        if (diff && diff.length > 500000) {
          diff = diff.slice(0, 500000) + '\n\n... diff truncated (exceeded 500KB) ...';
        }
        if (!diff) diff = null; // empty string → null
      } catch (e) {
        console.error('Failed to capture diff:', e.message);
      }
    }

    const executionCost = costData.costUsd || 0;
    const existingCost = task.costUsd || 0;
    const updates = {
      status: 'done',
      commitHash: result.commitHash || null,
      diff,
      agentLog: result.summary || costData.agentText.slice(0, 2000),
      tokenUsage: {
        ...(task.tokenUsage || {}),
        execution: { input: costData.inputTokens, output: costData.outputTokens },
      },
      costUsd: existingCost + executionCost,
    };
    if (branchName) {
      updates.branch = branchName;
      updates.baseBranch = baseBranch;
    }

    const updated = state.updateTask(task.id, updates);
    // Exclude diff from broadcast to avoid large WebSocket payloads
    const { diff: _diff, ...broadcastUpdates } = updates;
    broadcast('execution:completed', { taskId: task.id, ...broadcastUpdates, result, costUsd: executionCost });

    emitNotification('task:completed', {
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      commitHash: result.commitHash || null,
    });
    if (checkAllTasksDone(project.id)) {
      emitNotification('all-tasks:done', {
        projectId: project.id,
        taskCount: state.getTasks(project.id).length,
      });
    }

    // Auto-test after execution commit if enabled
    if (result.commitHash && project.autoTestOnCommit) {
      broadcast('project:test-started', { projectId: project.id });
      runTests(project).then((testResult) => {
        broadcast('project:test-completed', { projectId: project.id, passed: testResult.passed, summary: testResult.summary, output: testResult.output });
        if (!testResult.passed) {
          emitNotification('test:failure', {
            projectId: project.id,
            summary: testResult.summary,
          });
        }
      }).catch((err) => {
        broadcast('project:test-completed', { projectId: project.id, passed: false, summary: err.message || 'Auto-test failed', output: '' });
        emitNotification('test:failure', {
          projectId: project.id,
          summary: err.message || 'Auto-test failed',
        });
      });
    }

    return updated;
  } catch (err) {
    const aborted = state.wasAborted(task.id);
    const revertStatus = task.plan ? 'planned' : 'proposed';
    const agentLog = aborted
      ? 'Aborted by user'
      : `Execution failed (agent exited unexpectedly). The previous agent may have left partial changes in the working directory. Error: ${err.message}`;
    state.updateTask(task.id, { status: revertStatus, agentLog });
    broadcast('execution:failed', { taskId: task.id, error: agentLog, aborted, status: revertStatus });
    emitNotification('task:failed', {
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      error: agentLog,
      aborted,
    });
    if (!aborted) throw err;
  } finally {
    logStream.end();
    // Checkout back to base branch if we created a per-task branch
    if (baseBranch) {
      try {
        await gitExec(['checkout', baseBranch], cwd);
      } catch (e) {
        console.error('Failed to checkout base branch:', e.message);
      }
    }
    state.removeProcess(task.id);
    state.clearAborted(task.id);
    stopPolling();
    state.unlockProject(project.id);
    advanceQueue(project.id);
    unregisterAgent(agentId);
  }
}

export async function runExecutionInWorktree(task, modelId, worktreeCwd) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const project = state.getProject(task.projectId);
  if (!project) throw new Error('Project not found');

  const wtCwd = toWSLPath(worktreeCwd);

  // Capture HEAD before execution so we can diff afterwards
  let preCommitHash;
  try {
    preCommitHash = await gitExec(['rev-parse', 'HEAD'], wtCwd);
  } catch {
    preCommitHash = null;
  }

  const prompt = buildExecutionPrompt(task);
  const { cmd, args, useStdin } = buildExecutionCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'executing', executedBy: modelId });
  broadcast('execution:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'executing', projectId: project.id, taskId: task.id, modelId });

  const stopPolling = pollGitStatus(wtCwd, task.id);
  const { stream: wtLogStream } = createLogStream(task.id, 'execution');

  const { proc, promise } = spawnAgent(
    cmd, args, worktreeCwd,
    useStdin ? prompt : null,
    (bytes, textChunk) => {
      broadcast('execution:progress', { taskId: task.id, bytesReceived: bytes });
      if (textChunk) broadcast('log:chunk', { taskId: task.id, phase: 'execution', chunk: textChunk });
    },
    wtLogStream
  );

  state.setProcess(task.id, { proc, stopPolling });

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const result = parseExecutionOutput(costData.agentText);

    // Capture diff between pre-execution HEAD and post-execution state
    let diff = null;
    if (preCommitHash) {
      try {
        const postRef = result.commitHash || 'HEAD';
        diff = await new Promise((resolve, reject) => {
          execFile('git', ['diff', `${preCommitHash}..${postRef}`], { cwd: wtCwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
          });
        });
        if (diff && diff.length > 500000) {
          diff = diff.slice(0, 500000) + '\n\n... diff truncated (exceeded 500KB) ...';
        }
        if (!diff) diff = null;
      } catch (e) {
        console.error('Failed to capture diff in worktree:', e.message);
      }
    }

    const executionCost = costData.costUsd || 0;
    const existingCost = task.costUsd || 0;
    const updates = {
      status: 'done',
      commitHash: result.commitHash || null,
      diff,
      agentLog: result.summary || costData.agentText.slice(0, 2000),
      tokenUsage: {
        ...(task.tokenUsage || {}),
        execution: { input: costData.inputTokens, output: costData.outputTokens },
      },
      costUsd: existingCost + executionCost,
    };

    const updated = state.updateTask(task.id, updates);
    const { diff: _diff, ...broadcastUpdates } = updates;
    broadcast('execution:completed', { taskId: task.id, ...broadcastUpdates, result, costUsd: executionCost });
    return updated;
  } catch (err) {
    const revertStatus = task.plan ? 'planned' : 'proposed';
    const agentLog = `Execution failed in worktree: ${err.message}`;
    state.updateTask(task.id, { status: revertStatus, agentLog });
    broadcast('execution:failed', { taskId: task.id, error: agentLog, aborted: false, status: revertStatus });
    throw err;
  } finally {
    wtLogStream.end();
    state.removeProcess(task.id);
    stopPolling();
    unregisterAgent(agentId);
  }
}

export { spawnAgent };

export async function runTestSetup(project, testInfo) {
  if (!state.lockProject(project.id)) {
    throw new Error('Project is already being executed on');
  }

  const prompt = buildTestSetupPrompt(project.path, testInfo);
  const { cmd, args, useStdin } = buildTestSetupCommand(DEFAULT_MODEL_ID, prompt);

  broadcast('setup-tests:started', { projectId: project.id });
  const agentId = registerAgent({ type: 'settingUpTests', projectId: project.id, modelId: DEFAULT_MODEL_ID });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? prompt : null,
      (bytes) => { broadcast('setup-tests:progress', { projectId: project.id, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, DEFAULT_MODEL_ID);
    const result = parseTestSetupOutput(costData.agentText);

    // If the agent reported a test command, validate and save it on the project
    if (result.testCommand) {
      const check = validateTestCommand(result.testCommand);
      if (check.valid) {
        state.updateProject(project.id, { testCommand: result.testCommand });
      }
    }

    broadcast('setup-tests:completed', {
      projectId: project.id,
      success: result.success,
      summary: result.summary || 'Test setup complete',
      commitHash: result.commitHash || null,
      testCommand: result.testCommand || null,
    });

    return result;
  } catch (err) {
    broadcast('setup-tests:failed', {
      projectId: project.id,
      error: err.message,
    });
    throw err;
  } finally {
    state.unlockProject(project.id);
    advanceQueue(project.id);
    unregisterAgent(agentId);
  }
}
