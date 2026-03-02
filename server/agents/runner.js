import { spawn, execFile, execFileSync } from 'child_process';
import { homedir } from 'os';
import { broadcast } from '../ws.js';
import { buildGenerationCommand, buildExecutionCommand, buildTestSetupCommand } from './cli.js';
import { buildGenerationPrompt, buildExecutionPrompt, buildPlanningPrompt, buildTestSetupPrompt, getBuiltInTemplates } from './prompts.js';
import { parseGenerationOutput, parseExecutionOutput, parsePlanningOutput, parseTestSetupOutput } from './parser.js';
import { toWSLPath } from '../paths.js';
import { DEFAULT_MODEL_ID } from '../models.js';
import { runTests } from '../testing.js';
import * as state from '../state.js';
import { registerAgent, unregisterAgent } from '../census.js';

const TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

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

function spawnAgent(cmd, args, cwd, stdinData, onProgress) {
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
      if (onProgress) onProgress(stdout.length);
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Agent exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
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
      (bytes) => { broadcast('generation:progress', { projectId: project.id, bytesReceived: bytes }); }
    );
    const stdout = await promise;
    const proposals = parseGenerationOutput(stdout);

    // Dedup: skip proposals whose title matches an existing task for this project
    const existingTitles = new Set(
      state.getTasks(project.id).map((t) => t.title.toLowerCase().trim())
    );

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
      createdTasks.push(task);
      broadcast('task:created', task);
    }

    broadcast('generation:completed', {
      projectId: project.id,
      taskCount: createdTasks.length,
      skippedDuplicates: skipped,
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

  const { proc, promise } = spawnAgent(
    cmd, args, project.path,
    useStdin ? prompt : null,
    (bytes) => { broadcast('planning:progress', { taskId: task.id, bytesReceived: bytes }); }
  );
  state.setProcess(task.id, proc);

  try {
    const stdout = await promise;
    const plan = parsePlanningOutput(stdout);

    const updated = state.updateTask(task.id, { status: 'planned', plan, plannedBy: modelId });
    broadcast('planning:completed', { taskId: task.id, plan, plannedBy: modelId });

    return updated;
  } catch (err) {
    // Task may have been dismissed while planning — skip updates if removed
    if (state.getTask(task.id)) {
      state.updateTask(task.id, { status: 'proposed', agentLog: err.message });
      broadcast('planning:failed', { taskId: task.id, error: err.message });
    }
    throw err;
  } finally {
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

  const prompt = buildExecutionPrompt(task);
  const { cmd, args, useStdin } = buildExecutionCommand(modelId, prompt);

  state.updateTask(task.id, { status: 'executing', executedBy: modelId });
  broadcast('execution:started', { taskId: task.id });
  const agentId = registerAgent({ type: 'executing', projectId: project.id, taskId: task.id, modelId });

  const stopPolling = pollGitStatus(toWSLPath(project.path), task.id);

  const { proc, promise } = spawnAgent(
    cmd, args, project.path,
    useStdin ? prompt : null,
    (bytes) => { broadcast('execution:progress', { taskId: task.id, bytesReceived: bytes }); }
  );

  state.setProcess(task.id, { proc, stopPolling });

  try {
    const stdout = await promise;
    const result = parseExecutionOutput(stdout);

    const updates = {
      status: 'done',
      commitHash: result.commitHash || null,
      agentLog: result.summary || stdout.slice(0, 2000),
    };

    const updated = state.updateTask(task.id, updates);
    broadcast('execution:completed', { taskId: task.id, ...updates, result });

    // Auto-test after execution commit if enabled
    if (result.commitHash && project.autoTestOnCommit) {
      broadcast('project:test-started', { projectId: project.id });
      runTests(project).then((testResult) => {
        broadcast('project:test-completed', { projectId: project.id, passed: testResult.passed, summary: testResult.summary, output: testResult.output });
      }).catch((err) => {
        broadcast('project:test-completed', { projectId: project.id, passed: false, summary: err.message || 'Auto-test failed', output: '' });
      });
    }

    return updated;
  } catch (err) {
    const aborted = state.wasAborted(task.id);
    const revertStatus = aborted && task.plan ? 'planned' : 'proposed';
    const agentLog = aborted ? 'Aborted by user' : err.message;
    state.updateTask(task.id, { status: revertStatus, agentLog });
    broadcast('execution:failed', { taskId: task.id, error: agentLog, aborted, status: revertStatus });
    if (!aborted) throw err;
  } finally {
    state.removeProcess(task.id);
    state.clearAborted(task.id);
    stopPolling();
    state.unlockProject(project.id);
    advanceQueue(project.id);
    unregisterAgent(agentId);
  }
}

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
      (bytes) => { broadcast('setup-tests:progress', { projectId: project.id, bytesReceived: bytes }); }
    );
    const stdout = await promise;
    const result = parseTestSetupOutput(stdout);

    // If the agent reported a test command, save it on the project
    if (result.testCommand) {
      state.updateProject(project.id, { testCommand: result.testCommand });
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
