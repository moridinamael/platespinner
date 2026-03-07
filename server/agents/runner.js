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
import { writeReplayEvent, compressReplayLog } from './replay.js';
import { runPostExecutionHooks, runPreExecutionHooks, runPostPlanningHooks, runTaskValidators, emitPluginEvent } from '../plugins/manager.js';

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

  writeReplayEvent(project.id, 'generation', {
    type: 'prompt_sent', phase: 'generation', projectId: project.id, modelId, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? prompt : null,
      (bytes) => { broadcast('generation:progress', { projectId: project.id, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);

    writeReplayEvent(project.id, 'generation', {
      type: 'response_received', phase: 'generation', projectId: project.id, modelId,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs, numTurns: costData.numTurns,
    });

    const proposals = parseGenerationOutput(costData.agentText);

    writeReplayEvent(project.id, 'generation', {
      type: 'parsed_output', phase: 'generation', projectId: project.id,
      parsedResult: proposals, proposalCount: proposals.length,
    });

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
    emitPluginEvent('generation:completed', { projectId: project.id, taskCount: createdTasks.length });

    return createdTasks;
  } catch (err) {
    writeReplayEvent(project.id, 'generation', {
      type: 'error', phase: 'generation', projectId: project.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
    broadcast('generation:failed', {
      projectId: project.id,
      error: err.message,
    });
    throw err;
  } finally {
    compressReplayLog(project.id, 'generation').catch(() => {});
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

  writeReplayEvent(task.id, 'planning', {
    type: 'prompt_sent', phase: 'planning', taskId: task.id, projectId: project.id, modelId, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

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
  state.setProcess(task.id, { proc, phase: 'planning' });

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);

    writeReplayEvent(task.id, 'planning', {
      type: 'response_received', phase: 'planning', taskId: task.id, modelId,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs,
    });

    const plan = parsePlanningOutput(costData.agentText);

    writeReplayEvent(task.id, 'planning', {
      type: 'parsed_output', phase: 'planning', taskId: task.id,
      parsedResult: typeof plan === 'string' ? plan.slice(0, 10000) : plan,
    });

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

    // Run post-planning hooks
    try {
      await runPostPlanningHooks(task, plan, project);
    } catch (hookErr) {
      console.error('Post-planning hook error:', hookErr.message);
    }
    emitPluginEvent('planning:completed', { taskId: task.id, plan });

    return updated;
  } catch (err) {
    writeReplayEvent(task.id, 'planning', {
      type: 'error', phase: 'planning', taskId: task.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
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
    compressReplayLog(task.id, 'planning').catch(() => {});
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
    emitNotification('budget:exceeded', {
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      totalSpent: budget.totalSpent,
      limit: budget.limit,
    });
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

  // Run pre-execution hooks
  try {
    await runPreExecutionHooks(task, project);
  } catch (hookErr) {
    console.error('Pre-execution hook error:', hookErr.message);
  }

  const prompt = buildExecutionPrompt(task);
  const { cmd, args, useStdin } = buildExecutionCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'executing', executedBy: modelId });
  broadcast('execution:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'executing', projectId: project.id, taskId: task.id, modelId });

  writeReplayEvent(task.id, 'execution', {
    type: 'prompt_sent', phase: 'execution', taskId: task.id, projectId: project.id, modelId, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

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

  state.setProcess(task.id, { proc, stopPolling, phase: 'executing' });

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const result = parseExecutionOutput(costData.agentText);

    writeReplayEvent(task.id, 'execution', {
      type: 'response_received', phase: 'execution', taskId: task.id, modelId,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs, numTurns: costData.numTurns,
      exitCode: 0,
    });

    writeReplayEvent(task.id, 'execution', {
      type: 'parsed_output', phase: 'execution', taskId: task.id,
      parsedResult: { commitHash: result.commitHash, summary: result.summary?.slice(0, 10000) },
    });

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

    // Run task validators
    try {
      const validation = await runTaskValidators(task, result, project);
      if (!validation.valid) {
        const revertStatus = task.plan ? 'planned' : 'proposed';
        state.updateTask(task.id, {
          status: revertStatus,
          agentLog: `Task validator rejected: ${validation.message}`,
        });
        broadcast('execution:validation-failed', {
          taskId: task.id,
          validator: validation.validatorName,
          message: validation.message,
        });
      }
    } catch (valErr) {
      console.error('Task validator error:', valErr.message);
    }

    // Run post-execution hooks
    try {
      await runPostExecutionHooks(task, result, project);
    } catch (hookErr) {
      console.error('Post-execution hook error:', hookErr.message);
    }
    emitPluginEvent('execution:completed', { taskId: task.id, commitHash: result.commitHash, costUsd: executionCost });

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

    // Check cost threshold after cost is accumulated
    const thresholdSettings = state.getNotificationSettings(project.id);
    if (thresholdSettings.costThresholdUsd != null) {
      const costSummary = state.getProjectCostSummary(project.id);
      if (costSummary.totalCost >= thresholdSettings.costThresholdUsd) {
        emitNotification('cost:threshold-exceeded', {
          projectId: project.id,
          totalCost: costSummary.totalCost,
          threshold: thresholdSettings.costThresholdUsd,
        });
      }
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
    writeReplayEvent(task.id, 'execution', {
      type: 'error', phase: 'execution', taskId: task.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
    const aborted = state.wasAborted(task.id);
    const revertStatus = task.plan ? 'planned' : 'proposed';
    const agentLog = aborted
      ? 'Aborted by user'
      : `Execution failed (agent exited unexpectedly). The previous agent may have left partial changes in the working directory. Error: ${err.message}`;
    state.updateTask(task.id, { status: revertStatus, agentLog });
    broadcast('execution:failed', { taskId: task.id, error: agentLog, aborted, status: revertStatus });
    emitPluginEvent('execution:failed', { taskId: task.id, error: agentLog, aborted });
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
    compressReplayLog(task.id, 'execution').catch(() => {});
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

  // Run pre-execution hooks
  try {
    await runPreExecutionHooks(task, project);
  } catch (hookErr) {
    console.error('Pre-execution hook error:', hookErr.message);
  }

  const prompt = buildExecutionPrompt(task);
  const { cmd, args, useStdin } = buildExecutionCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'executing', executedBy: modelId });
  broadcast('execution:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'executing', projectId: project.id, taskId: task.id, modelId });

  writeReplayEvent(task.id, 'execution', {
    type: 'prompt_sent', phase: 'execution', taskId: task.id, projectId: project.id, modelId, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

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

  state.setProcess(task.id, { proc, stopPolling, phase: 'executing' });

  try {
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);
    const result = parseExecutionOutput(costData.agentText);

    writeReplayEvent(task.id, 'execution', {
      type: 'response_received', phase: 'execution', taskId: task.id, modelId,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs, numTurns: costData.numTurns,
    });

    writeReplayEvent(task.id, 'execution', {
      type: 'parsed_output', phase: 'execution', taskId: task.id,
      parsedResult: { commitHash: result.commitHash, summary: result.summary?.slice(0, 10000) },
    });

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

    // Run task validators
    try {
      const validation = await runTaskValidators(task, result, project);
      if (!validation.valid) {
        const revertStatus = task.plan ? 'planned' : 'proposed';
        state.updateTask(task.id, {
          status: revertStatus,
          agentLog: `Task validator rejected: ${validation.message}`,
        });
        broadcast('execution:validation-failed', {
          taskId: task.id,
          validator: validation.validatorName,
          message: validation.message,
        });
      }
    } catch (valErr) {
      console.error('Task validator error:', valErr.message);
    }

    // Run post-execution hooks
    try {
      await runPostExecutionHooks(task, result, project);
    } catch (hookErr) {
      console.error('Post-execution hook error:', hookErr.message);
    }
    emitPluginEvent('execution:completed', { taskId: task.id, commitHash: result.commitHash, costUsd: executionCost });

    return updated;
  } catch (err) {
    writeReplayEvent(task.id, 'execution', {
      type: 'error', phase: 'execution', taskId: task.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
    const revertStatus = task.plan ? 'planned' : 'proposed';
    const agentLog = `Execution failed in worktree: ${err.message}`;
    state.updateTask(task.id, { status: revertStatus, agentLog });
    broadcast('execution:failed', { taskId: task.id, error: agentLog, aborted: false, status: revertStatus });
    emitPluginEvent('execution:failed', { taskId: task.id, error: agentLog, aborted: false });
    throw err;
  } finally {
    wtLogStream.end();
    compressReplayLog(task.id, 'execution').catch(() => {});
    state.removeProcess(task.id);
    stopPolling();
    unregisterAgent(agentId);
  }
}

export { spawnAgent, extractCostData };

export async function runTestSetup(project, testInfo) {
  if (!state.lockProject(project.id)) {
    throw new Error('Project is already being executed on');
  }

  const prompt = buildTestSetupPrompt(project.path, testInfo);
  const { cmd, args, useStdin } = buildTestSetupCommand(DEFAULT_MODEL_ID, prompt);

  broadcast('setup-tests:started', { projectId: project.id });
  const agentId = registerAgent({ type: 'settingUpTests', projectId: project.id, modelId: DEFAULT_MODEL_ID });

  writeReplayEvent(project.id, 'testSetup', {
    type: 'prompt_sent', phase: 'testSetup', projectId: project.id, modelId: DEFAULT_MODEL_ID, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? prompt : null,
      (bytes) => { broadcast('setup-tests:progress', { projectId: project.id, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, DEFAULT_MODEL_ID);

    writeReplayEvent(project.id, 'testSetup', {
      type: 'response_received', phase: 'testSetup', projectId: project.id, modelId: DEFAULT_MODEL_ID,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs,
    });

    const result = parseTestSetupOutput(costData.agentText);

    writeReplayEvent(project.id, 'testSetup', {
      type: 'parsed_output', phase: 'testSetup', projectId: project.id,
      parsedResult: { success: result.success, summary: result.summary, testCommand: result.testCommand },
    });

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
    writeReplayEvent(project.id, 'testSetup', {
      type: 'error', phase: 'testSetup', projectId: project.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
    broadcast('setup-tests:failed', {
      projectId: project.id,
      error: err.message,
    });
    throw err;
  } finally {
    compressReplayLog(project.id, 'testSetup').catch(() => {});
    state.unlockProject(project.id);
    advanceQueue(project.id);
    unregisterAgent(agentId);
  }
}
