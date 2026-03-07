import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs modules before importing state (prevents load() from touching disk)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  };
});

import * as state from './state.js';

describe('Process handle normalization', () => {
  beforeEach(() => {
    state.load();
  });

  it('normalizes a bare ChildProcess into { proc, stopPolling, phase }', () => {
    const fakeProc = { kill: vi.fn(), pid: 123 };
    state.setProcess('task-1', fakeProc);
    const handle = state.getProcess('task-1');
    expect(handle).toEqual({ proc: fakeProc, stopPolling: null, phase: null });
    expect(handle.proc).toBe(fakeProc);
    state.removeProcess('task-1');
  });

  it('preserves { proc, stopPolling } and fills phase as null', () => {
    const fakeProc = { kill: vi.fn(), pid: 456 };
    const stopPolling = vi.fn();
    state.setProcess('task-2', { proc: fakeProc, stopPolling });
    const handle = state.getProcess('task-2');
    expect(handle.proc).toBe(fakeProc);
    expect(handle.stopPolling).toBe(stopPolling);
    expect(handle.phase).toBeNull();
    state.removeProcess('task-2');
  });

  it('stores full { proc, stopPolling, phase } shape correctly', () => {
    const fakeProc = { kill: vi.fn(), pid: 789 };
    const stopPolling = vi.fn();
    state.setProcess('task-3', { proc: fakeProc, stopPolling, phase: 'executing' });
    const handle = state.getProcess('task-3');
    expect(handle.proc).toBe(fakeProc);
    expect(handle.stopPolling).toBe(stopPolling);
    expect(handle.phase).toBe('executing');
    state.removeProcess('task-3');
  });

  it('getProcess returns undefined for unknown taskId', () => {
    expect(state.getProcess('nonexistent')).toBeUndefined();
  });

  it('removeProcess clears the handle', () => {
    const fakeProc = { kill: vi.fn(), pid: 999 };
    state.setProcess('task-4', fakeProc);
    state.removeProcess('task-4');
    expect(state.getProcess('task-4')).toBeUndefined();
  });
});

describe('Dismiss task with active process', () => {
  let project, task;

  beforeEach(() => {
    state.load();
    project = state.addProject({ name: 'test', path: '/tmp/test' });
  });

  it('dismiss during planning state — handle.proc.kill does not throw', () => {
    task = state.addTask({ projectId: project.id, title: 'Plan me' });
    state.updateTask(task.id, { status: 'planning' });

    // Simulate what runPlanning does: store { proc, phase: 'planning' }
    const fakeProc = { kill: vi.fn(), pid: 100 };
    state.setProcess(task.id, { proc: fakeProc, phase: 'planning' });

    // Simulate what the dismiss route does
    const handle = state.getProcess(task.id);
    expect(() => handle.proc.kill('SIGTERM')).not.toThrow();
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    // stopPolling is null for planning, calling it conditionally should be safe
    expect(handle.stopPolling).toBeNull();

    state.removeProcess(task.id);
    state.removeTask(task.id);
  });

  it('dismiss during executing state — handle.proc.kill and stopPolling work', () => {
    task = state.addTask({ projectId: project.id, title: 'Execute me' });
    state.updateTask(task.id, { status: 'executing' });

    // Simulate what runExecution does
    const fakeProc = { kill: vi.fn(), pid: 200 };
    const stopPolling = vi.fn();
    state.setProcess(task.id, { proc: fakeProc, stopPolling, phase: 'executing' });

    // Simulate what the dismiss route does
    const handle = state.getProcess(task.id);
    expect(() => handle.proc.kill('SIGTERM')).not.toThrow();
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    if (handle.stopPolling) handle.stopPolling();
    expect(stopPolling).toHaveBeenCalled();

    state.removeProcess(task.id);
    state.removeTask(task.id);
  });

  it('dismiss with no running process does not throw', () => {
    task = state.addTask({ projectId: project.id, title: 'Idle task' });
    const handle = state.getProcess(task.id);
    expect(handle).toBeUndefined();
    state.removeTask(task.id);
  });
});
