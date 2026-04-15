import { spawn, execFile, execFileSync } from 'child_process';
import { createWriteStream, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { broadcast } from '../ws.js';
import { buildGenerationCommand, buildExecutionCommand, buildTestSetupCommand, buildRankingCommand } from './cli.js';
import { buildGenerationPrompt, buildExecutionPrompt, buildPlanningPrompt, buildTestSetupPrompt, buildJudgmentPrompt, buildRankingPrompt, getBuiltInTemplates } from './prompts.js';
import { parseGenerationOutput, parseExecutionOutput, parsePlanningOutput, parseTestSetupOutput, parseJudgmentOutput, parseRankingOutput, extractClaudeJsonOutput, estimateTokensFromText } from './parser.js';
import { toWSLPath } from '../paths.js';
import { DEFAULT_MODEL_ID, getModel, estimateCost } from '../models.js';
import { runTests, validateTestCommand } from '../testing.js';
import * as state from '../state.js';
import { LOGS_DIR } from '../state.js';
import { registerAgent, unregisterAgent } from '../census.js';
import { emitNotification, checkAllTasksDone } from '../notifications.js';
import { writeReplayEvent, compressReplayLog } from './replay.js';
import { runPostExecutionHooks, runPreExecutionHooks, runPostPlanningHooks, runTaskValidators, emitPluginEvent } from '../plugins/manager.js';
import { renderPRBody } from '../prUtils.js';
import { trackPR, fetchPRStatus } from '../prStatus.js';
import { findSimilarTasks, extractFilePaths, findFileConflicts } from '../similarity.js';

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
  const queue = state.getQueue(projectId);

  // Find the first unblocked, valid task in the queue
  for (let i = 0; i < queue.length; i++) {
    const candidateId = queue[i];
    const candidate = state.getTask(candidateId);
    if (!candidate || candidate.status !== 'queued') continue;
    if (state.isTaskBlocked(candidateId)) continue;

    // Found an unblocked task — remove it from queue and execute
    state.removeFromQueue(projectId, candidateId);
    broadcast('execution:queue-advanced', {
      projectId,
      startedTaskId: candidateId,
      queue: state.getQueue(projectId),
    });
    broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
    runExecution(candidate, candidate.executedBy).catch((advanceErr) => {
      console.error('Queue auto-advance failed:', advanceErr.message);
      const staleTask = state.getTask(candidateId);
      if (staleTask && staleTask.status === 'queued') {
        state.updateTask(candidateId, {
          status: staleTask.plan ? 'planned' : 'proposed',
          agentLog: `Auto-advance failed: ${advanceErr.message}`,
        });
        broadcast('execution:failed', {
          taskId: candidateId,
          error: `Auto-advance failed: ${advanceErr.message}`,
          aborted: false,
          status: staleTask.plan ? 'planned' : 'proposed',
        });
      }
    });
    return;
  }

  // Queue is empty or all tasks are blocked — broadcast so clients clear stale state
  broadcast('execution:queue-updated', state.getQueueSnapshot(projectId));
}

const GIT_POLL_MS = 30_000; // poll git status every 30s

function pollGitStatus(cwd, taskId) {
  const SEP = '---GIT_POLL_SEP---';
  let lastOutput = '';
  let intervalId = null;

  const poll = () => {
    execFile(
      'bash',
      ['-c', `git diff --stat HEAD 2>/dev/null; echo '${SEP}'; git ls-files --others --exclude-standard 2>/dev/null`],
      { cwd },
      (err, stdout) => {
        if (err) return;
        if (stdout === lastOutput) return;
        lastOutput = stdout;

        const [diffPart, untrackedPart] = stdout.split(SEP);

        if (diffPart) {
          const lines = diffPart.trim().split('\n').filter(Boolean);
          if (lines.length > 0) {
            const summary = lines[lines.length - 1].trim();
            const files = lines.slice(0, -1).map((l) => l.trim()).filter(Boolean);
            broadcast('execution:git', { taskId, summary, files });
          }
        }

        if (untrackedPart) {
          const untracked = untrackedPart.trim().split('\n').filter(Boolean);
          if (untracked.length > 0) {
            broadcast('execution:git-untracked', { taskId, files: untracked });
          }
        }
      }
    );
  };

  // Stagger start with random jitter so concurrent tasks don't all poll simultaneously
  const startTimer = setTimeout(() => {
    poll();
    intervalId = setInterval(poll, GIT_POLL_MS);
  }, Math.floor(Math.random() * GIT_POLL_MS));

  return () => {
    clearTimeout(startTimer);
    if (intervalId !== null) clearInterval(intervalId);
  };
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
    const existingTasks = state.getTasks(project.id);
    const existingTitles = new Set(
      existingTasks.map((t) => t.title.toLowerCase().trim())
    );

    const costPerTask = costData.costUsd ? costData.costUsd / Math.max(proposals.length, 1) : null;

    const createdTasks = [];
    const pendingReview = [];
    let skipped = 0;
    for (const proposal of proposals) {
      // Phase 1: Exact match — auto-skip
      if (existingTitles.has(proposal.title.toLowerCase().trim())) {
        skipped++;
        continue;
      }

      // Phase 2: Semantic similarity check
      const similar = findSimilarTasks(proposal, existingTasks);

      const task = state.addTask({
        projectId: project.id,
        title: proposal.title,
        description: proposal.description,
        rationale: proposal.rationale,
        effort: proposal.estimatedEffort || 'medium',
        generatedBy: modelId,
      });

      if (similar.length > 0) {
        state.updateTask(task.id, {
          similarTasks: similar.map(s => ({ taskId: s.taskId, title: s.title, score: s.score, status: s.status })),
        });
        pendingReview.push({ taskId: task.id, title: task.title, similar });
      }

      // Store ranking data if present in the proposal
      if (proposal.rank != null || proposal.rankingScore != null || proposal.rankingReason) {
        state.updateTask(task.id, {
          rankingRank: proposal.rank != null ? Number(proposal.rank) || null : null,
          rankingScore: proposal.rankingScore != null ? Number(proposal.rankingScore) || null : null,
          rankingReason: proposal.rankingReason || null,
        });
      }

      if (costPerTask != null) {
        state.updateTask(task.id, {
          tokenUsage: { generation: { input: costData.inputTokens, output: costData.outputTokens } },
          costUsd: costPerTask,
        });
      }
      createdTasks.push(state.getTask(task.id));
      broadcast('task:created', state.getTask(task.id));
    }

    // Broadcast duplicate review needed
    if (pendingReview.length > 0) {
      broadcast('generation:duplicates-found', {
        projectId: project.id,
        duplicates: pendingReview,
      });
    }

    broadcast('generation:completed', {
      projectId: project.id,
      taskCount: createdTasks.length,
      skippedDuplicates: skipped,
      pendingReview: pendingReview.length,
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

export async function runRanking(project, modelId) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const proposedTasks = state.getTasks(project.id).filter(t => t.status === 'proposed');
  if (proposedTasks.length === 0) throw new Error('No proposed tasks to rank');

  const prompt = buildRankingPrompt(project.path, proposedTasks);
  const { cmd, args, useStdin } = buildRankingCommand(modelId, prompt);

  broadcast('ranking:started', { projectId: project.id });
  const agentId = registerAgent({ type: 'ranking', projectId: project.id, modelId });

  writeReplayEvent(project.id, 'ranking', {
    type: 'prompt_sent', phase: 'ranking', projectId: project.id, modelId, prompt,
    cmd, args: args.filter(a => a !== prompt),
  });

  try {
    const { promise } = spawnAgent(
      cmd, args, project.path,
      useStdin ? prompt : null,
      (bytes) => { broadcast('ranking:progress', { projectId: project.id, bytesReceived: bytes }); },
      null
    );
    const stdout = await promise;
    const costData = extractCostData(stdout, prompt, modelId);

    writeReplayEvent(project.id, 'ranking', {
      type: 'response_received', phase: 'ranking', projectId: project.id, modelId,
      rawResponse: stdout.slice(0, 100000),
      costUsd: costData.costUsd, inputTokens: costData.inputTokens,
      outputTokens: costData.outputTokens, durationMs: costData.durationMs, numTurns: costData.numTurns,
    });

    const rankingItems = parseRankingOutput(costData.agentText);

    writeReplayEvent(project.id, 'ranking', {
      type: 'parsed_output', phase: 'ranking', projectId: project.id,
      parsedResult: rankingItems, itemCount: rankingItems.length,
    });

    // Extract ordered task IDs, filtering to only valid proposed tasks
    const proposedIds = new Set(proposedTasks.map(t => t.id));
    const rankedIds = rankingItems
      .map(item => item.taskId)
      .filter(id => proposedIds.has(id));

    // Append any proposed tasks the LLM missed to the end
    for (const t of proposedTasks) {
      if (!rankedIds.includes(t.id)) rankedIds.push(t.id);
    }

    // Reorder tasks
    state.reorderTasks(rankedIds);

    // Split cost evenly across ranked tasks
    const costPerTask = costData.costUsd ? costData.costUsd / rankedIds.length : 0;
    const tokenShareInput = costData.inputTokens ? Math.round(costData.inputTokens / rankedIds.length) : 0;
    const tokenShareOutput = costData.outputTokens ? Math.round(costData.outputTokens / rankedIds.length) : 0;

    for (const taskId of rankedIds) {
      const task = state.getTask(taskId);
      if (!task) continue;
      state.updateTask(taskId, {
        tokenUsage: {
          ...(task.tokenUsage || {}),
          ranking: { input: tokenShareInput, output: tokenShareOutput },
        },
        costUsd: (task.costUsd || 0) + costPerTask,
      });
    }

    // Persist ranking data on each task and build reasoning map
    const reasoningMap = {};
    for (const item of rankingItems) {
      if (item.taskId && item.reasoning) reasoningMap[item.taskId] = item.reasoning;
      if (item.taskId) {
        const rankUpdates = {};
        if (item.rank != null) rankUpdates.rankingRank = Number(item.rank) || null;
        if (item.score != null) rankUpdates.rankingScore = Number(item.score) || null;
        if (item.reasoning) rankUpdates.rankingReason = item.reasoning;
        if (Object.keys(rankUpdates).length > 0) {
          state.updateTask(item.taskId, rankUpdates);
        }
      }
    }

    broadcast('ranking:completed', {
      projectId: project.id,
      rankedIds,
      rankedCount: rankedIds.length,
      reasoning: reasoningMap,
      costUsd: costData.costUsd,
    });
    broadcast('tasks:reordered', { orderedIds: rankedIds });

    return { rankedIds, reasoning: reasoningMap, costUsd: costData.costUsd };
  } catch (err) {
    writeReplayEvent(project.id, 'ranking', {
      type: 'error', phase: 'ranking', projectId: project.id,
      error: err.message, stack: err.stack?.slice(0, 2000),
    });
    broadcast('ranking:failed', { projectId: project.id, error: err.message });
    throw err;
  } finally {
    compressReplayLog(project.id, 'ranking').catch(() => {});
    unregisterAgent(agentId);
  }
}

export async function runExecution(task, modelId, options = {}) {
  modelId = modelId || DEFAULT_MODEL_ID;
  const project = state.getProject(task.projectId);
  if (!project) throw new Error('Project not found');

  if (!options.lockHeld) {
    if (!state.lockProject(project.id)) {
      throw new Error('Project is already being executed on');
    }
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

  // File conflict detection
  if (task.plan) {
    const taskFiles = extractFilePaths(task.plan);
    if (taskFiles.length > 0) {
      state.updateTask(task.id, { trackedFiles: taskFiles });
      const otherExecuting = state.getTasks(project.id)
        .filter(t => t.id !== task.id && (t.status === 'executing' || t.status === 'queued') && t.trackedFiles)
        .map(t => ({ id: t.id, title: t.title, trackedFiles: t.trackedFiles }));
      const conflicts = findFileConflicts(task.id, taskFiles, otherExecuting);
      if (conflicts.length > 0) {
        broadcast('execution:file-conflicts', { taskId: task.id, conflicts });
      }
    }
  }

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

    // Notify dependents that they may now be unblocked
    const dependents = state.getDependents(task.id);
    if (dependents.length > 0) {
      for (const dep of dependents) {
        broadcast('task:updated', { ...dep, _blocked: state.isTaskBlocked(dep.id) });
      }
    }

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

    // Test-gated execution: run tests after a successful commit when autoTestOnCommit is enabled
    if (result.commitHash && project.autoTestOnCommit) {
      broadcast('project:test-started', { projectId: project.id, taskId: task.id });
      try {
        const testResult = await runTests(project);
        state.updateProject(project.id, {
          lastTestResult: {
            passed: testResult.passed,
            summary: testResult.summary,
            output: testResult.output,
            timestamp: Date.now(),
          },
        });
        broadcast('project:test-completed', {
          projectId: project.id,
          taskId: task.id,
          passed: testResult.passed,
          summary: testResult.summary,
        });

        if (!testResult.passed) {
          // ROLLBACK: revert the commit
          const revertCwd = toWSLPath(project.path);
          if (project.branchStrategy === 'per-task' && preCommitHash) {
            // Per-task branch: safe to hard reset
            try {
              await gitExec(['reset', '--hard', preCommitHash], revertCwd);
            } catch (resetErr) {
              console.error('Git reset failed:', resetErr.message);
            }
          } else {
            // Direct branch: use revert to preserve history
            try {
              await gitExec(['revert', '--no-edit', result.commitHash], revertCwd);
            } catch (revertErr) {
              console.error('Git revert failed:', revertErr.message);
              try { await gitExec(['revert', '--abort'], revertCwd); } catch { /* ignore */ }
            }
          }

          // Mark task as failed
          const currentTask = state.getTask(task.id);
          const newFailureCount = (currentTask.failureCount || 0) + 1;
          state.updateTask(task.id, {
            status: 'failed',
            failureCount: newFailureCount,
            lastTestOutput: (testResult.output || testResult.summary || '').slice(0, 50000),
            agentLog: `Test-gated execution failed (attempt #${newFailureCount}). Tests did not pass after commit ${result.commitHash.slice(0, 7)}.\n\nTest summary: ${testResult.summary}`,
          });
          broadcast('execution:test-failed', {
            taskId: task.id,
            commitHash: result.commitHash,
            testSummary: testResult.summary,
            failureCount: newFailureCount,
            status: 'failed',
          });
          emitNotification('test:failure', {
            projectId: project.id,
            taskId: task.id,
            taskTitle: task.title,
            summary: testResult.summary,
          });

          return state.getTask(task.id);
        }
      } catch (testErr) {
        console.error('Test execution error:', testErr.message);
        broadcast('project:test-completed', {
          projectId: project.id,
          taskId: task.id,
          passed: false,
          summary: testErr.message || 'Test execution error',
        });
      }
    }

    // Auto-create PR if enabled and on per-task branch
    const currentTask = state.getTask(task.id);
    if (branchName && project.autoCreatePR && currentTask && currentTask.status === 'done' && currentTask.commitHash && !currentTask.prUrl) {
      try {
        const prBody = renderPRBody(project.prTemplate, currentTask);
        await gitExec(['push', '-u', 'origin', branchName], cwd);

        const prArgs = ['pr', 'create', '--head', branchName, '--title', currentTask.title, '--body', prBody];
        if (project.prBaseBranch) prArgs.push('--base', project.prBaseBranch);
        if (project.prReviewers) prArgs.push('--reviewer', project.prReviewers);

        const prOutput = await new Promise((resolve, reject) => {
          execFile('gh', prArgs, { cwd, timeout: 30000 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
          });
        });

        const prUrl = prOutput.trim();
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]) : null;

        state.updateTask(task.id, { prUrl, prNumber });
        broadcast('task:updated', state.getTask(task.id));

        if (prNumber) {
          trackPR(task.id, project.id, prNumber);
          try {
            const prStatus = await fetchPRStatus(project.path, prNumber);
            state.updateTask(task.id, { prStatus });
            broadcast('task:pr-status', { taskId: task.id, prStatus });
          } catch { /* initial status fetch is best-effort */ }
        }
      } catch (prErr) {
        console.error('Auto-PR creation failed:', prErr.message);
        broadcast('pr:creation-failed', { taskId: task.id, error: prErr.message });
      }
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

  // File conflict detection (worktree)
  if (task.plan) {
    const taskFiles = extractFilePaths(task.plan);
    if (taskFiles.length > 0) {
      state.updateTask(task.id, { trackedFiles: taskFiles });
      const otherExecuting = state.getTasks(project.id)
        .filter(t => t.id !== task.id && (t.status === 'executing' || t.status === 'queued') && t.trackedFiles)
        .map(t => ({ id: t.id, title: t.title, trackedFiles: t.trackedFiles }));
      const conflicts = findFileConflicts(task.id, taskFiles, otherExecuting);
      if (conflicts.length > 0) {
        broadcast('execution:file-conflicts', { taskId: task.id, conflicts });
      }
    }
  }

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

export async function runTestSetup(project, testInfo, options = {}) {
  if (!options.lockHeld) {
    if (!state.lockProject(project.id)) {
      throw new Error('Project is already being executed on');
    }
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
