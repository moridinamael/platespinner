import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const mockFileHandle = {
  writeFile: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

// Mock fs modules before importing state (prevents load() from touching disk)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    openSync: vi.fn(() => 99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: vi.fn(async () => mockFileHandle),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
  };
});

import * as state from './state.js';

function makeState({ projects = [], tasks = [], executionQueues = {} } = {}) {
  return JSON.stringify({
    projects,
    tasks,
    promptTemplates: [],
    notificationSettings: {},
    executionQueues,
    autoclicker: { enabled: false, enabledProjects: [], maxParallel: 3, standoffSeconds: 0 },
  });
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    projectId: overrides.projectId || 'proj-1',
    title: overrides.title || 'Test Task',
    description: '',
    rationale: '',
    effort: 'medium',
    status: 'proposed',
    generatedBy: null,
    plannedBy: null,
    plan: null,
    executedBy: null,
    commitHash: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    agentLog: null,
    diff: null,
    tokenUsage: null,
    costUsd: 0,
    createdAt: Date.now(),
    sortOrder: Date.now(),
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: overrides.id || 'proj-1',
    name: overrides.name || 'Test Project',
    path: overrides.path || '/tmp/test',
    url: null,
    testCommand: null,
    autoTestOnCommit: false,
    lastTestResult: null,
    lastRailwayResult: null,
    budgetLimitUsd: null,
    branchStrategy: 'direct',
    sortOrder: 0,
    ...overrides,
  };
}

function loadWithState(stateJson) {
  readFileSync.mockReturnValueOnce(stateJson);
  state.load();
}

beforeEach(() => {
  readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  state.load(); // reset to empty state
});

// --- Crash recovery: executing tasks ---

describe('crash recovery — executing tasks', () => {
  it('reverts executing task WITH plan to planned', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't1', projectId: 'p1', status: 'executing', plan: 'some plan' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t1').status).toBe('planned');
  });

  it('reverts executing task WITHOUT plan to proposed', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't2', projectId: 'p1', status: 'executing', plan: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t2').status).toBe('proposed');
  });

  it('appends interruption note to null agentLog', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't3', projectId: 'p1', status: 'executing', agentLog: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t3').agentLog).toBe('[Server restarted — execution was interrupted]');
  });

  it('appends interruption note to existing agentLog with newline separator', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't4', projectId: 'p1', status: 'executing', agentLog: 'Previous log entry' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t4').agentLog).toBe('Previous log entry\n[Server restarted — execution was interrupted]');
  });
});

// --- Crash recovery: planning tasks ---

describe('crash recovery — planning tasks', () => {
  it('reverts planning task to proposed', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't5', projectId: 'p1', status: 'planning' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t5').status).toBe('proposed');
  });

  it('does not modify agentLog for planning tasks', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't6', projectId: 'p1', status: 'planning', agentLog: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t6').agentLog).toBeNull();
  });
});

// --- Crash recovery: queued tasks ---

describe('crash recovery — queued tasks', () => {
  it('reverts queued task WITH plan to planned and adds dequeue note', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't7', projectId: 'p1', status: 'queued', plan: 'a plan', agentLog: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t7').status).toBe('planned');
    expect(state.getTask('t7').agentLog).toBe('[Server restarted — task was dequeued]');
  });

  it('reverts queued task WITHOUT plan to proposed and adds dequeue note', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't8', projectId: 'p1', status: 'queued', plan: null, agentLog: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t8').status).toBe('proposed');
    expect(state.getTask('t8').agentLog).toBe('[Server restarted — task was dequeued]');
  });

  it('appends dequeue note to existing agentLog', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't9', projectId: 'p1', status: 'queued', agentLog: 'existing log' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t9').agentLog).toBe('existing log\n[Server restarted — task was dequeued]');
  });
});

// --- Crash recovery: execution queues cleared ---

describe('crash recovery — execution queues cleared', () => {
  it('clears execution queues after recovering transient tasks', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't10', projectId: 'p1', status: 'executing', plan: 'plan' });
    loadWithState(makeState({
      projects: [proj],
      tasks: [task],
      executionQueues: { 'p1': ['t10'] },
    }));

    expect(state.getAllQueues()).toEqual({});
  });

  it('preserves execution queues when no transient tasks exist', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't11', projectId: 'p1', status: 'proposed' });
    loadWithState(makeState({
      projects: [proj],
      tasks: [task],
      executionQueues: { 'p1': ['t11'] },
    }));

    expect(state.getAllQueues()).toEqual({ 'p1': [{ taskId: 't11', position: 1 }] });
  });
});

// --- Crash recovery: stable tasks untouched ---

describe('crash recovery — stable tasks untouched', () => {
  it('does not modify tasks in proposed status', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't12', projectId: 'p1', status: 'proposed', agentLog: null });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t12').status).toBe('proposed');
    expect(state.getTask('t12').agentLog).toBeNull();
  });

  it('does not modify tasks in planned status', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't13', projectId: 'p1', status: 'planned', plan: 'a plan', agentLog: 'some log' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t13').status).toBe('planned');
    expect(state.getTask('t13').plan).toBe('a plan');
    expect(state.getTask('t13').agentLog).toBe('some log');
  });

  it('does not modify tasks in done status', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't14', projectId: 'p1', status: 'done', agentLog: 'final log' });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t14').status).toBe('done');
    expect(state.getTask('t14').agentLog).toBe('final log');
  });
});

// --- sortOrder backfill: projects ---

describe('sortOrder backfill — projects', () => {
  it('assigns sequential sortOrders to projects missing the field', () => {
    const p1 = { id: 'p1', name: 'A', path: '/a', url: null, testCommand: null };
    const p2 = { id: 'p2', name: 'B', path: '/b', url: null, testCommand: null };
    // No sortOrder field
    loadWithState(makeState({ projects: [p1, p2] }));

    expect(state.getProject('p1').sortOrder).toBe(0);
    expect(state.getProject('p2').sortOrder).toBe(1);
  });

  it('does not overwrite existing sortOrders on projects', () => {
    const p1 = { id: 'p1', name: 'A', path: '/a', sortOrder: 5 };
    const p2 = { id: 'p2', name: 'B', path: '/b' };
    loadWithState(makeState({ projects: [p1, p2] }));

    expect(state.getProject('p1').sortOrder).toBe(5);
    expect(state.getProject('p2').sortOrder).toBe(1);
  });
});

// --- sortOrder backfill: tasks ---

describe('sortOrder backfill — tasks', () => {
  it('assigns createdAt as sortOrder for tasks missing the field', () => {
    const proj = makeProject({ id: 'p1' });
    const createdAt = 1700000000000;
    const task = makeTask({ id: 't15', projectId: 'p1', createdAt });
    delete task.sortOrder;
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t15').sortOrder).toBe(createdAt);
  });

  it('falls back to index when task has no createdAt or sortOrder', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't16', projectId: 'p1' });
    delete task.sortOrder;
    delete task.createdAt;
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t16').sortOrder).toBe(0);
  });

  it('does not overwrite existing sortOrder on tasks', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't17', projectId: 'p1', sortOrder: 42 });
    loadWithState(makeState({ projects: [proj], tasks: [task] }));

    expect(state.getTask('t17').sortOrder).toBe(42);
  });
});

// --- Mixed scenario ---

describe('crash recovery — mixed scenario', () => {
  it('recovers multiple tasks in different transient states in a single load', () => {
    const proj = makeProject({ id: 'p1' });
    const executing1 = makeTask({ id: 'e1', projectId: 'p1', status: 'executing', plan: 'plan', agentLog: null });
    const executing2 = makeTask({ id: 'e2', projectId: 'p1', status: 'executing', plan: null, agentLog: 'old log' });
    const planning1 = makeTask({ id: 'pl1', projectId: 'p1', status: 'planning', agentLog: null });
    const queued1 = makeTask({ id: 'q1', projectId: 'p1', status: 'queued', plan: 'plan', agentLog: null });
    const queued2 = makeTask({ id: 'q2', projectId: 'p1', status: 'queued', plan: null, agentLog: 'log' });
    const stable1 = makeTask({ id: 's1', projectId: 'p1', status: 'proposed', agentLog: null });
    const stable2 = makeTask({ id: 's2', projectId: 'p1', status: 'planned', plan: 'plan', agentLog: 'log' });
    const stable3 = makeTask({ id: 's3', projectId: 'p1', status: 'done', agentLog: 'done log' });

    loadWithState(makeState({
      projects: [proj],
      tasks: [executing1, executing2, planning1, queued1, queued2, stable1, stable2, stable3],
      executionQueues: { 'p1': ['q1', 'q2'] },
    }));

    // Executing with plan → planned
    expect(state.getTask('e1').status).toBe('planned');
    expect(state.getTask('e1').agentLog).toBe('[Server restarted — execution was interrupted]');

    // Executing without plan → proposed
    expect(state.getTask('e2').status).toBe('proposed');
    expect(state.getTask('e2').agentLog).toBe('old log\n[Server restarted — execution was interrupted]');

    // Planning → proposed, no agentLog change
    expect(state.getTask('pl1').status).toBe('proposed');
    expect(state.getTask('pl1').agentLog).toBeNull();

    // Queued with plan → planned
    expect(state.getTask('q1').status).toBe('planned');
    expect(state.getTask('q1').agentLog).toBe('[Server restarted — task was dequeued]');

    // Queued without plan → proposed
    expect(state.getTask('q2').status).toBe('proposed');
    expect(state.getTask('q2').agentLog).toBe('log\n[Server restarted — task was dequeued]');

    // Stable tasks untouched
    expect(state.getTask('s1').status).toBe('proposed');
    expect(state.getTask('s1').agentLog).toBeNull();
    expect(state.getTask('s2').status).toBe('planned');
    expect(state.getTask('s2').agentLog).toBe('log');
    expect(state.getTask('s3').status).toBe('done');
    expect(state.getTask('s3').agentLog).toBe('done log');

    // Execution queues cleared
    expect(state.getAllQueues()).toEqual({});
  });
});

// --- Corrupt primary — backup recovery ---

describe('corrupt primary — backup recovery', () => {
  it('recovers from backup when primary contains invalid JSON', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't1', projectId: 'p1', status: 'proposed' });
    const validBackup = makeState({ projects: [proj], tasks: [task] });

    readFileSync
      .mockReturnValueOnce('{{not valid json')
      .mockReturnValueOnce(validBackup);

    state.load();

    expect(state.getProject('p1')).toBeDefined();
    expect(state.getTask('t1')).toBeDefined();
    expect(state.getTask('t1').status).toBe('proposed');
  });

  it('recovers from backup when primary is truncated', () => {
    const proj = makeProject({ id: 'p1' });
    const task = makeTask({ id: 't1', projectId: 'p1' });
    const validBackup = makeState({ projects: [proj], tasks: [task] });

    readFileSync
      .mockReturnValueOnce('{"projects":[{"id":"p1"')  // truncated
      .mockReturnValueOnce(validBackup);

    state.load();

    expect(state.getProject('p1')).toBeDefined();
    expect(state.getTask('t1')).toBeDefined();
  });

  it('starts empty when both primary and backup are corrupt', () => {
    readFileSync
      .mockReturnValueOnce('corrupt primary')
      .mockReturnValueOnce('corrupt backup too');

    state.load();

    expect(state.getProjects()).toEqual([]);
    expect(state.getTasks()).toEqual([]);
  });

  it('starts empty when primary is corrupt and backup does not exist', () => {
    readFileSync
      .mockReturnValueOnce('corrupt primary')
      .mockImplementationOnce(() => { throw new Error('ENOENT'); });

    state.load();

    expect(state.getProjects()).toEqual([]);
    expect(state.getTasks()).toEqual([]);
  });

  it('loads from backup when primary does not exist but backup does', () => {
    const proj = makeProject({ id: 'p1' });
    const validBackup = makeState({ projects: [proj] });

    readFileSync
      .mockImplementationOnce(() => { throw new Error('ENOENT'); })  // primary missing
      .mockReturnValueOnce(validBackup);  // backup exists

    state.load();

    expect(state.getProject('p1')).toBeDefined();
  });

  it('logs explicit corruption message for corrupt primary', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    readFileSync
      .mockReturnValueOnce('not json')
      .mockImplementationOnce(() => { throw new Error('ENOENT'); });

    state.load();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Corrupt primary state file')
    );
    consoleSpy.mockRestore();
  });
});
