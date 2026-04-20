import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs modules before importing state (prevents load() from touching disk)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
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

// NOTE: this suite verifies the state-level invariant that `isTaskBlocked`
// is derived live from the blocker's current status (no cached flag), so a
// dependent becomes actionable the moment its blocker transitions to 'done'.
// Queue auto-start on completion is a runner concern and is exercised in
// runner tests, not here.
describe('Dependency auto-clear on done', () => {
  let project;
  const createdTaskIds = [];

  beforeEach(() => {
    state.load();
    project = state.addProject({ name: 'dep-test', path: '/tmp/dep-test' });
    createdTaskIds.length = 0;
  });

  afterEach(() => {
    for (const id of createdTaskIds) state.removeTask(id);
    state.removeProject(project.id);
  });

  function makeTask(title, opts = {}) {
    const t = state.addTask({ projectId: project.id, title });
    createdTaskIds.push(t.id);
    if (opts.dependencies) state.updateTask(t.id, { dependencies: opts.dependencies });
    if (opts.status) state.updateTask(t.id, { status: opts.status });
    return state.getTask(t.id);
  }

  it('B with deps=[A] is initially blocked while A is proposed', () => {
    const A = makeTask('A');
    const B = makeTask('B', { dependencies: [A.id] });

    expect(state.isTaskBlocked(B.id)).toBe(true);
    const unblocked = state.getUnblockedTasks(project.id);
    expect(unblocked.map(t => t.id)).not.toContain(B.id);
    // A has no deps so A itself is unblocked
    expect(unblocked.map(t => t.id)).toContain(A.id);
  });

  it('B with deps=[A] remains blocked while A is executing', () => {
    const A = makeTask('A');
    const B = makeTask('B', { dependencies: [A.id] });

    state.updateTask(A.id, { status: 'executing' });

    expect(state.isTaskBlocked(B.id)).toBe(true);

    // getBlockers returns live references — A's status reads as 'executing' now.
    const blockers = state.getBlockers(B.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].id).toBe(A.id);
    expect(blockers[0].status).toBe('executing');
  });

  it('B becomes unblocked the moment A transitions to done', () => {
    const A = makeTask('A', { status: 'executing' });
    const B = makeTask('B', { dependencies: [A.id] });

    expect(state.isTaskBlocked(B.id)).toBe(true);

    state.updateTask(A.id, { status: 'done' });

    expect(state.isTaskBlocked(B.id)).toBe(false);
    const unblocked = state.getUnblockedTasks(project.id);
    expect(unblocked.map(t => t.id)).toContain(B.id);

    // getBlockers still reports A as a blocker record, but its status is now 'done'.
    const blockers = state.getBlockers(B.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].status).toBe('done');

    // Unblocking must not mutate B's own status — only its eligibility.
    expect(state.getTask(B.id).status).toBe('proposed');
  });

  it('multiple dependents are all unblocked when a shared blocker completes', () => {
    const A = makeTask('A', { status: 'executing' });
    const B = makeTask('B', { dependencies: [A.id] });
    const C = makeTask('C', { dependencies: [A.id] });

    expect(state.isTaskBlocked(B.id)).toBe(true);
    expect(state.isTaskBlocked(C.id)).toBe(true);

    state.updateTask(A.id, { status: 'done' });

    expect(state.isTaskBlocked(B.id)).toBe(false);
    expect(state.isTaskBlocked(C.id)).toBe(false);

    const dependents = state.getDependents(A.id).map(t => t.id).sort();
    expect(dependents).toEqual([B.id, C.id].sort());
  });

  it('B with deps=[A, X] stays blocked until BOTH A and X are done', () => {
    const A = makeTask('A');
    const X = makeTask('X');
    const B = makeTask('B', { dependencies: [A.id, X.id] });

    expect(state.isTaskBlocked(B.id)).toBe(true);

    state.updateTask(A.id, { status: 'done' });
    expect(state.isTaskBlocked(B.id)).toBe(true);

    state.updateTask(X.id, { status: 'done' });
    expect(state.isTaskBlocked(B.id)).toBe(false);
  });

  it('removing A strips A from B.dependencies so B is unblocked', () => {
    const A = makeTask('A');
    const B = makeTask('B', { dependencies: [A.id] });

    expect(state.isTaskBlocked(B.id)).toBe(true);

    // Remove A directly; removeTask cleans up reverse references.
    state.removeTask(A.id);
    // A is no longer tracked in createdTaskIds cleanup — drop it so afterEach doesn't re-remove.
    const idx = createdTaskIds.indexOf(A.id);
    if (idx !== -1) createdTaskIds.splice(idx, 1);

    const refreshedB = state.getTask(B.id);
    expect(refreshedB.dependencies).toEqual([]);
    expect(state.isTaskBlocked(B.id)).toBe(false);
  });

  it("blocker with status 'failed' keeps dependent blocked (fail-closed semantics)", () => {
    // This assertion is documentation-by-test: changing the unblock policy to
    // include 'failed' should require deliberately updating this test.
    const A = makeTask('A');
    const B = makeTask('B', { dependencies: [A.id] });

    state.updateTask(A.id, { status: 'failed' });
    expect(state.isTaskBlocked(B.id)).toBe(true);
  });
});
