import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ─── Module-level mocks (before any runner import) ───

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(() => Buffer.from('/usr/bin:/usr/local/bin')),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn() })),
    statSync: vi.fn(),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: vi.fn(async () => ({ writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() })),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
  };
});

vi.mock('../ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('./cli.js', () => ({
  buildGenerationCommand: vi.fn(() => ({ cmd: 'claude', args: ['-p', '--model', 'test-model'], useStdin: true })),
  buildExecutionCommand: vi.fn(() => ({ cmd: 'claude', args: ['-p', '--model', 'test-model'], useStdin: true })),
  buildTestSetupCommand: vi.fn(() => ({ cmd: 'claude', args: ['-p', '--model', 'test-model'], useStdin: true })),
}));

vi.mock('./prompts.js', () => ({
  buildGenerationPrompt: vi.fn(() => 'gen-prompt'),
  buildExecutionPrompt: vi.fn(() => 'exec-prompt'),
  buildPlanningPrompt: vi.fn(() => 'plan-prompt'),
  buildTestSetupPrompt: vi.fn(() => 'setup-prompt'),
  buildJudgmentPrompt: vi.fn(() => 'judge-prompt'),
  getBuiltInTemplates: vi.fn(() => []),
}));

vi.mock('./parser.js', () => ({
  parseGenerationOutput: vi.fn(() => [{ title: 'Task 1', description: 'Desc 1' }]),
  parseExecutionOutput: vi.fn(() => ({ commitHash: 'abc123', summary: 'Done' })),
  parsePlanningOutput: vi.fn(() => 'Step 1: do things'),
  parseTestSetupOutput: vi.fn(() => ({ success: true, testCommand: 'npm test' })),
  parseJudgmentOutput: vi.fn(() => ({})),
  extractClaudeJsonOutput: vi.fn((stdout) => ({
    text: stdout, costUsd: 0.05, inputTokens: 100, outputTokens: 200, durationMs: 1000, numTurns: 1,
  })),
  estimateTokensFromText: vi.fn(() => 50),
}));

vi.mock('../paths.js', () => ({ toWSLPath: vi.fn((p) => p) }));

vi.mock('../models.js', () => ({
  DEFAULT_MODEL_ID: 'test-model',
  getModel: vi.fn(() => ({ id: 'test-model', provider: 'claude', pricing: { inputPer1M: 15, outputPer1M: 75 } })),
  estimateCost: vi.fn(() => 0.01),
}));

vi.mock('../testing.js', () => ({
  runTests: vi.fn(async () => ({ passed: true, summary: 'All passed', output: '' })),
  validateTestCommand: vi.fn(() => ({ valid: true })),
}));

vi.mock('../census.js', () => ({
  registerAgent: vi.fn(() => 'agent-id-1'),
  unregisterAgent: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  emitNotification: vi.fn(),
  checkAllTasksDone: vi.fn(() => false),
}));

vi.mock('./replay.js', () => ({
  writeReplayEvent: vi.fn(),
  compressReplayLog: vi.fn(async () => {}),
}));

vi.mock('../plugins/manager.js', () => ({
  runPostExecutionHooks: vi.fn(async () => {}),
  runPreExecutionHooks: vi.fn(async () => {}),
  runPostPlanningHooks: vi.fn(async () => {}),
  runTaskValidators: vi.fn(async () => ({ valid: true })),
  emitPluginEvent: vi.fn(),
  getCustomToolNames: vi.fn(() => []),
}));

vi.mock('../prUtils.js', () => ({ renderPRBody: vi.fn(() => 'PR body') }));

vi.mock('../prStatus.js', () => ({
  trackPR: vi.fn(),
  fetchPRStatus: vi.fn(async () => ({ state: 'open' })),
}));

vi.mock('../similarity.js', () => ({
  findSimilarTasks: vi.fn(() => []),
  extractFilePaths: vi.fn(() => []),
  findFileConflicts: vi.fn(() => []),
}));

// ─── Imports ───

import { spawn, execFile } from 'child_process';
import { broadcast } from '../ws.js';
import * as state from '../state.js';
import { parseGenerationOutput, parseExecutionOutput, parsePlanningOutput, extractClaudeJsonOutput, estimateTokensFromText } from './parser.js';
import { buildGenerationCommand, buildExecutionCommand } from './cli.js';
import { buildGenerationPrompt, buildExecutionPrompt, buildPlanningPrompt } from './prompts.js';
import { registerAgent, unregisterAgent } from '../census.js';
import { getModel, estimateCost } from '../models.js';
import { runTests } from '../testing.js';
import { runGeneration, runPlanning, runExecution, spawnAgent, extractCostData } from './runner.js';

// ─── Helpers ───

function createMockProcess(exitCode = 0, stdoutData = 'output', stderrData = '') {
  const proc = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;

  queueMicrotask(() => {
    if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) proc.stderr.emit('data', Buffer.from(stderrData));
    proc.emit('close', exitCode);
  });

  return proc;
}

function createHangingProcess() {
  const proc = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

// ─── Test setup ───

let project, task;

beforeEach(() => {
  state.load();
  project = state.addProject({ name: 'Test Project', path: '/tmp/test-project' });
  task = state.addTask({ projectId: project.id, title: 'Test Task', description: 'desc' });
  vi.clearAllMocks();

  // Default spawn: lazily creates process so queueMicrotask fires after listeners attach
  spawn.mockImplementation(() => createMockProcess(0, '{"result":"done"}'));

  // Default execFile: simulate git success
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (cb) cb(null, 'mock-git-output', '');
    return { on: vi.fn() };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───

describe('spawnAgent', () => {
  it('spawns process with correct cmd, args, and cwd', async () => {
    const mockProc = createMockProcess(0, 'hello');
    spawn.mockReturnValue(mockProc);

    const { proc, promise } = spawnAgent('claude', ['-p'], '/tmp/test', null, null, null);
    const stdout = await promise;

    expect(spawn).toHaveBeenCalledWith('claude', ['-p'], expect.objectContaining({
      cwd: '/tmp/test',
      env: expect.objectContaining({ PATH: expect.any(String) }),
    }));
    expect(stdout).toBe('hello');
    expect(proc).toBe(mockProc);
  });

  it('writes stdinData to proc.stdin when provided', async () => {
    const mockProc = createMockProcess(0, 'ok');
    spawn.mockReturnValue(mockProc);

    const { promise } = spawnAgent('claude', ['-p'], '/tmp/test', 'hello input', null, null);
    await promise;

    expect(mockProc.stdin.write).toHaveBeenCalledWith('hello input');
    expect(mockProc.stdin.end).toHaveBeenCalled();
  });

  it('does not write to stdin when stdinData is null', async () => {
    const mockProc = createMockProcess(0, 'ok');
    spawn.mockReturnValue(mockProc);

    const { promise } = spawnAgent('claude', ['-p'], '/tmp/test', null, null, null);
    await promise;

    expect(mockProc.stdin.write).not.toHaveBeenCalled();
  });

  it('calls onProgress callback with accumulated bytes and chunk', async () => {
    const proc = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 111;
    spawn.mockReturnValue(proc);

    const onProgress = vi.fn();
    const { promise } = spawnAgent('claude', [], '/tmp', null, onProgress, null);

    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from('abc'));
      proc.stdout.emit('data', Buffer.from('de'));
      proc.emit('close', 0);
    });

    await promise;

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(3, 'abc');
    expect(onProgress).toHaveBeenCalledWith(5, 'de');
  });

  it('writes stdout/stderr to logStream when provided', async () => {
    const mockProc = createMockProcess(0, 'out-data', 'err-data');
    spawn.mockReturnValue(mockProc);

    const logStream = { write: vi.fn(), end: vi.fn() };
    const { promise } = spawnAgent('claude', [], '/tmp', null, null, logStream);
    await promise;

    expect(logStream.write).toHaveBeenCalled();
    expect(logStream.end).toHaveBeenCalled();
  });

  it('rejects when process exits with non-zero code', async () => {
    const mockProc = createMockProcess(1, '', 'error message');
    spawn.mockReturnValue(mockProc);

    const { promise } = spawnAgent('claude', [], '/tmp', null, null, null);

    await expect(promise).rejects.toThrow('exited with code 1');
  });

  it('rejects when process emits error event', async () => {
    const proc = createHangingProcess();
    spawn.mockReturnValue(proc);

    const { promise } = spawnAgent('claude', [], '/tmp', null, null, null);
    queueMicrotask(() => proc.emit('error', new Error('spawn ENOENT')));

    await expect(promise).rejects.toThrow('spawn ENOENT');
  });

  it('rejects on timeout and kills process', async () => {
    vi.useFakeTimers();
    const proc = createHangingProcess();
    spawn.mockReturnValue(proc);

    const { promise } = spawnAgent('claude', [], '/tmp', null, null, null);

    vi.advanceTimersByTime(60 * 60 * 1000);

    await expect(promise).rejects.toThrow('timed out');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('extractCostData', () => {
  it('delegates to extractClaudeJsonOutput for claude provider', () => {
    const result = extractCostData('{"some":"json"}', 'prompt', 'test-model');

    expect(extractClaudeJsonOutput).toHaveBeenCalledWith('{"some":"json"}');
    expect(result).toHaveProperty('agentText');
    expect(result).toHaveProperty('costUsd', 0.05);
    expect(result).toHaveProperty('inputTokens', 100);
    expect(result).toHaveProperty('outputTokens', 200);
    expect(result).toHaveProperty('durationMs', 1000);
    expect(result).toHaveProperty('numTurns', 1);
  });

  it('estimates tokens for non-claude provider', () => {
    getModel.mockReturnValueOnce({ id: 'codex-model', provider: 'codex', pricing: { inputPer1M: 10, outputPer1M: 30 } });

    const result = extractCostData('output text', 'prompt text', 'codex-model');

    expect(estimateTokensFromText).toHaveBeenCalled();
    expect(estimateCost).toHaveBeenCalled();
    expect(result.durationMs).toBeNull();
    expect(result.numTurns).toBeNull();
    expect(result.agentText).toBe('output text');
  });
});

describe('runGeneration', () => {
  it('builds prompt and spawns agent with correct arguments', async () => {
    await runGeneration(project, null, 'test-model', 'custom prompt');

    expect(buildGenerationPrompt).toHaveBeenCalledWith(project.path, 'custom prompt');
    expect(buildGenerationCommand).toHaveBeenCalledWith('test-model', 'gen-prompt');
    expect(spawn).toHaveBeenCalled();
  });

  it('broadcasts generation:started and generation:completed events', async () => {
    await runGeneration(project);

    const calls = broadcast.mock.calls.map(c => c[0]);
    expect(calls).toContain('generation:started');
    expect(calls).toContain('generation:completed');
  });

  it('parses stdout and creates tasks in state', async () => {
    parseGenerationOutput.mockReturnValueOnce([{ title: 'New Task', description: 'desc' }]);

    const result = await runGeneration(project);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('New Task');
    // Verify task exists in state (the original task + new one)
    const tasks = state.getTasks(project.id);
    expect(tasks.some(t => t.title === 'New Task')).toBe(true);
  });

  it('deduplicates against existing task titles', async () => {
    // 'Test Task' already exists from beforeEach
    parseGenerationOutput.mockReturnValueOnce([
      { title: 'Test Task', description: 'dup' },
      { title: 'Brand New', description: 'new' },
    ]);

    const result = await runGeneration(project);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Brand New');

    const completedCall = broadcast.mock.calls.find(c => c[0] === 'generation:completed');
    expect(completedCall[1].skippedDuplicates).toBe(1);
  });

  it('registers and unregisters agent', async () => {
    await runGeneration(project);

    expect(registerAgent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'generating',
      projectId: project.id,
    }));
    expect(unregisterAgent).toHaveBeenCalledWith('agent-id-1');
  });

  it('broadcasts generation:failed and re-throws on process error', async () => {
    spawn.mockReturnValue(createMockProcess(1, '', 'fatal error'));

    await expect(runGeneration(project)).rejects.toThrow();

    const calls = broadcast.mock.calls.map(c => c[0]);
    expect(calls).toContain('generation:failed');
  });

  it('unregisters agent even on failure', async () => {
    spawn.mockReturnValue(createMockProcess(1, '', 'fatal'));

    await expect(runGeneration(project)).rejects.toThrow();

    expect(unregisterAgent).toHaveBeenCalledWith('agent-id-1');
  });
});

describe('runPlanning', () => {
  it('sets task status to planning then planned on success', async () => {
    await runPlanning(task, 'test-model');

    const updated = state.getTask(task.id);
    expect(updated.status).toBe('planned');
  });

  it('stores plan from parser output on the task', async () => {
    parsePlanningOutput.mockReturnValueOnce('detailed plan here');

    await runPlanning(task);

    const updated = state.getTask(task.id);
    expect(updated.plan).toBe('detailed plan here');
  });

  it('uses buildGenerationCommand (read-only tools), not buildExecutionCommand', async () => {
    await runPlanning(task);

    expect(buildGenerationCommand).toHaveBeenCalled();
    expect(buildExecutionCommand).not.toHaveBeenCalled();
  });

  it('accumulates cost on existing task cost', async () => {
    state.updateTask(task.id, { costUsd: 0.10 });

    await runPlanning(task);

    const updated = state.getTask(task.id);
    expect(updated.costUsd).toBeCloseTo(0.15); // 0.10 + 0.05 from mock
  });

  it('broadcasts planning:started and planning:completed', async () => {
    await runPlanning(task);

    const calls = broadcast.mock.calls.map(c => c[0]);
    expect(calls).toContain('planning:started');
    expect(calls).toContain('planning:completed');
  });

  it('reverts task to proposed on failure', async () => {
    spawn.mockReturnValue(createMockProcess(1, '', 'plan failed'));

    await expect(runPlanning(task)).rejects.toThrow();

    const updated = state.getTask(task.id);
    expect(updated.status).toBe('proposed');
  });

  it('broadcasts planning:failed on error', async () => {
    spawn.mockReturnValue(createMockProcess(1, '', 'error'));

    await expect(runPlanning(task)).rejects.toThrow();

    const calls = broadcast.mock.calls.map(c => c[0]);
    expect(calls).toContain('planning:failed');
  });

  it('stores process handle and removes it in finally', async () => {
    const setProcessSpy = vi.spyOn(state, 'setProcess');
    const removeProcessSpy = vi.spyOn(state, 'removeProcess');

    await runPlanning(task);

    expect(setProcessSpy).toHaveBeenCalledWith(task.id, expect.objectContaining({ phase: 'planning' }));
    expect(removeProcessSpy).toHaveBeenCalledWith(task.id);

    setProcessSpy.mockRestore();
    removeProcessSpy.mockRestore();
  });

  it('unregisters agent even on failure', async () => {
    spawn.mockReturnValue(createMockProcess(1, '', 'err'));

    await expect(runPlanning(task)).rejects.toThrow();

    expect(unregisterAgent).toHaveBeenCalledWith('agent-id-1');
  });

  it('skips state update if task was dismissed during planning', async () => {
    // Use a hanging process we can control
    const proc = createHangingProcess();
    spawn.mockReturnValue(proc);

    const planPromise = runPlanning(task).catch(() => {});

    // Remove the task (simulating dismiss) then trigger process failure
    state.removeTask(task.id);
    queueMicrotask(() => {
      proc.emit('close', 1);
    });

    await planPromise;

    // The task should not exist (was removed), and no crash
    expect(state.getTask(task.id)).toBeUndefined();
  });
});

describe('runExecution', () => {
  describe('project locking', () => {
    it('acquires project lock and releases it in finally', async () => {
      await runExecution(task, 'test-model');

      expect(state.isProjectLocked(project.id)).toBe(false);
    });

    it('throws when project is already locked', async () => {
      state.lockProject(project.id);

      await expect(runExecution(task, 'test-model')).rejects.toThrow('already being executed');
    });

    it('skips lock acquisition when options.lockHeld is true', async () => {
      state.lockProject(project.id);

      // Should not throw — it skips the lock check
      await expect(runExecution(task, 'test-model', { lockHeld: true })).resolves.toBeDefined();
    });
  });

  describe('budget check', () => {
    it('throws when budget is exceeded', async () => {
      state.updateProject(project.id, { budgetLimitUsd: 1.00 });
      // Create a costly done task
      const costlyTask = state.addTask({ projectId: project.id, title: 'Costly' });
      state.updateTask(costlyTask.id, { costUsd: 1.50, status: 'done' });

      await expect(runExecution(task, 'test-model')).rejects.toThrow('Budget limit exceeded');
      // Lock should be released
      expect(state.isProjectLocked(project.id)).toBe(false);
    });
  });

  describe('happy path state transitions', () => {
    it('sets status to executing then done on success', async () => {
      await runExecution(task, 'test-model');

      const updated = state.getTask(task.id);
      expect(updated.status).toBe('done');
    });

    it('stores commitHash, agentLog, tokenUsage, costUsd on task', async () => {
      parseExecutionOutput.mockReturnValueOnce({ commitHash: 'abc123', summary: 'All done' });

      await runExecution(task, 'test-model');

      const updated = state.getTask(task.id);
      expect(updated.commitHash).toBe('abc123');
      expect(updated.agentLog).toBe('All done');
      expect(updated.tokenUsage).toHaveProperty('execution');
      expect(updated.costUsd).toBeGreaterThan(0);
    });

    it('broadcasts execution:started and execution:completed', async () => {
      await runExecution(task, 'test-model');

      const calls = broadcast.mock.calls.map(c => c[0]);
      expect(calls).toContain('execution:started');
      expect(calls).toContain('execution:completed');
    });
  });

  describe('process management', () => {
    it('registers and unregisters agent', async () => {
      await runExecution(task, 'test-model');

      expect(registerAgent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'executing',
        projectId: project.id,
        taskId: task.id,
      }));
      expect(unregisterAgent).toHaveBeenCalledWith('agent-id-1');
    });

    it('sets process handle and removes it in finally', async () => {
      const setProcessSpy = vi.spyOn(state, 'setProcess');
      const removeProcessSpy = vi.spyOn(state, 'removeProcess');

      await runExecution(task, 'test-model');

      expect(setProcessSpy).toHaveBeenCalledWith(task.id, expect.objectContaining({ phase: 'executing' }));
      expect(removeProcessSpy).toHaveBeenCalledWith(task.id);

      setProcessSpy.mockRestore();
      removeProcessSpy.mockRestore();
    });
  });

  describe('error paths', () => {
    it('reverts to planned status on failure when task has a plan', async () => {
      state.updateTask(task.id, { plan: 'some plan' });
      const taskWithPlan = state.getTask(task.id);
      spawn.mockImplementation(() => createMockProcess(1, '', 'exec failed'));

      await expect(runExecution(taskWithPlan, 'test-model')).rejects.toThrow();

      const updated = state.getTask(task.id);
      expect(updated.status).toBe('planned');
    });

    it('reverts to proposed status on failure when task has no plan', async () => {
      spawn.mockImplementation(() => createMockProcess(1, '', 'exec failed'));

      await expect(runExecution(task, 'test-model')).rejects.toThrow();

      const updated = state.getTask(task.id);
      expect(updated.status).toBe('proposed');
    });

    it('cleans up lock, process, polling on failure', async () => {
      spawn.mockImplementation(() => createMockProcess(1, '', 'err'));

      await expect(runExecution(task, 'test-model')).rejects.toThrow();

      expect(state.isProjectLocked(project.id)).toBe(false);
      expect(state.getProcess(task.id)).toBeUndefined();
    });

    it('broadcasts execution:failed on error', async () => {
      spawn.mockImplementation(() => createMockProcess(1, '', 'error'));

      await expect(runExecution(task, 'test-model')).rejects.toThrow();

      const calls = broadcast.mock.calls.map(c => c[0]);
      expect(calls).toContain('execution:failed');
    });
  });

  describe('abort handling', () => {
    it('does not re-throw when task was aborted', async () => {
      let capturedProc;
      spawn.mockImplementation(() => {
        capturedProc = createHangingProcess();
        return capturedProc;
      });

      const execPromise = runExecution(task, 'test-model');

      // Wait for spawn to be called and proc to exist
      await vi.waitFor(() => expect(capturedProc).toBeDefined());

      state.markAborted(task.id);
      capturedProc.stderr.emit('data', Buffer.from('killed'));
      capturedProc.emit('close', 1);

      // Should NOT throw — aborted tasks are silently handled
      await expect(execPromise).resolves.toBeUndefined();

      const failedCall = broadcast.mock.calls.find(c => c[0] === 'execution:failed');
      expect(failedCall[1].aborted).toBe(true);
    });
  });

  describe('test-gated execution', () => {
    it('runs tests after successful commit when autoTestOnCommit is enabled', async () => {
      state.updateProject(project.id, { autoTestOnCommit: true });
      parseExecutionOutput.mockReturnValueOnce({ commitHash: 'abc123', summary: 'done' });

      await runExecution(task, 'test-model');

      expect(runTests).toHaveBeenCalled();
    });

    it('marks task failed and reverts when tests fail', async () => {
      state.updateProject(project.id, { autoTestOnCommit: true });
      parseExecutionOutput.mockReturnValueOnce({ commitHash: 'abc123', summary: 'done' });
      runTests.mockResolvedValueOnce({ passed: false, summary: 'Tests failed', output: '1 failing' });

      await runExecution(task, 'test-model');

      const updated = state.getTask(task.id);
      expect(updated.status).toBe('failed');
      expect(updated.failureCount).toBe(1);

      // Should have called git revert (direct branch, not per-task)
      const revertCall = execFile.mock.calls.find(c =>
        c[0] === 'git' && c[1] && c[1].includes('revert')
      );
      expect(revertCall).toBeDefined();
    });
  });

  describe('branch strategy', () => {
    it('creates per-task branch when branchStrategy is per-task', async () => {
      state.updateProject(project.id, { branchStrategy: 'per-task' });

      await runExecution(task, 'test-model');

      // Should have called git checkout -b for the new branch
      const checkoutCall = execFile.mock.calls.find(c =>
        c[0] === 'git' && c[1] && c[1].some(a => a === 'checkout')
      );
      expect(checkoutCall).toBeDefined();

      const updated = state.getTask(task.id);
      expect(updated.branch).toMatch(/^kanban\/task-/);
    });
  });

  describe('queue advancement', () => {
    it('advances queue after execution completes', async () => {
      // Add a queued task
      const task2 = state.addTask({ projectId: project.id, title: 'Queued Task' });
      state.updateTask(task2.id, { status: 'queued' });
      state.enqueueTask(project.id, task2.id);

      await runExecution(task, 'test-model');

      // advanceQueue is called in finally; it broadcasts queue-updated
      const queueCalls = broadcast.mock.calls.filter(c => c[0] === 'execution:queue-updated');
      expect(queueCalls.length).toBeGreaterThan(0);
    });
  });
});

describe('error edge cases', () => {
  it('handles spawn ENOENT error (binary not found)', async () => {
    const proc = createHangingProcess();
    spawn.mockReturnValue(proc);

    const promise = runGeneration(project);
    queueMicrotask(() => {
      proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    });

    await expect(promise).rejects.toThrow('ENOENT');
    expect(unregisterAgent).toHaveBeenCalled();
  });

  it('handles process crash with null exit code', async () => {
    const proc = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 5555;
    spawn.mockReturnValue(proc);

    const promise = runGeneration(project);
    queueMicrotask(() => {
      proc.stderr.emit('data', Buffer.from('Killed'));
      proc.emit('close', null);
    });

    await expect(promise).rejects.toThrow('exited with code null');
  });
});
