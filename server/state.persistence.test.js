import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

// Shared mock file handle — captures written data
let lastWrittenData = null;
const mockFileHandle = {
  writeFile: vi.fn(async (data) => { lastWrittenData = data; }),
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

import { open, rename, copyFile } from 'fs/promises';
import * as state from './state.js';

// --- Helpers (same as state.recovery.test.js) ---

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

// --- Test suite ---

beforeEach(() => {
  vi.useFakeTimers();
  readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  state.load(); // reset to empty
  lastWrittenData = null;
  mockFileHandle.writeFile.mockClear();
  mockFileHandle.writeFile.mockImplementation(async (data) => { lastWrittenData = data; });
  mockFileHandle.sync.mockClear();
  mockFileHandle.sync.mockResolvedValue(undefined);
  mockFileHandle.close.mockClear();
  mockFileHandle.close.mockResolvedValue(undefined);
  open.mockClear();
  open.mockResolvedValue(mockFileHandle);
  rename.mockClear();
  rename.mockResolvedValue(undefined);
  copyFile.mockClear();
  copyFile.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Reset mocks to working state so flushState doesn't fail
  mockFileHandle.writeFile.mockImplementation(async (data) => { lastWrittenData = data; });
  mockFileHandle.sync.mockResolvedValue(undefined);
  mockFileHandle.close.mockResolvedValue(undefined);
  open.mockResolvedValue(mockFileHandle);
  rename.mockResolvedValue(undefined);
  copyFile.mockResolvedValue(undefined);
  // Flush any pending writes to reset _dirty/_debounceTimer module state
  await state.flushState();
  vi.useRealTimers();
});

// ==========================================
// Group 1: Debounced persistence — coalescing
// ==========================================

describe('debounced persistence — coalescing writes', () => {
  it('single mutation triggers exactly one write after 500ms', async () => {
    state.addProject({ name: 'P', path: '/p' });
    expect(rename).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('multiple rapid mutations coalesce into a single write', async () => {
    state.addProject({ name: 'P1', path: '/p1' });
    state.addProject({ name: 'P2', path: '/p2' });
    state.addProject({ name: 'P3', path: '/p3' });

    await vi.advanceTimersByTimeAsync(500);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('mutations after the debounce window trigger a second write', async () => {
    state.addProject({ name: 'P1', path: '/p1' });
    await vi.advanceTimersByTimeAsync(500);
    expect(rename).toHaveBeenCalledTimes(1);

    state.addProject({ name: 'P2', path: '/p2' });
    await vi.advanceTimersByTimeAsync(500);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('no write occurs if timer has not fully elapsed', async () => {
    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(400);
    expect(rename).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

// ==========================================
// Group 2: Serialization fidelity
// ==========================================

describe('serialization fidelity', () => {
  it('persisted JSON accurately reflects in-memory projects and tasks', async () => {
    const proj = state.addProject({ name: 'My Project', path: '/my/project' });
    const t1 = state.addTask({ projectId: proj.id, title: 'Task One', description: 'Desc 1' });
    const t2 = state.addTask({ projectId: proj.id, title: 'Task Two', description: 'Desc 2' });
    state.updateTask(t1.id, { status: 'planned', plan: 'my plan' });

    await vi.advanceTimersByTimeAsync(500);
    const data = JSON.parse(lastWrittenData);

    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].name).toBe('My Project');
    expect(data.projects[0].path).toBe('/my/project');

    expect(data.tasks).toHaveLength(2);
    const titles = data.tasks.map(t => t.title).sort();
    expect(titles).toEqual(['Task One', 'Task Two']);

    const serializedT1 = data.tasks.find(t => t.id === t1.id);
    expect(serializedT1.status).toBe('planned');
    expect(serializedT1.plan).toBe('my plan');

    expect(data.executionQueues).toBeDefined();
    expect(data.autoclicker).toBeDefined();
    expect(data.autoclicker.enabled).toBe(false);
  });

  it('persisted JSON includes execution queue state', async () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const task = state.addTask({ projectId: proj.id, title: 'T' });
    state.enqueueTask(proj.id, task.id);

    await vi.advanceTimersByTimeAsync(500);
    const data = JSON.parse(lastWrittenData);

    expect(data.executionQueues[proj.id]).toEqual([task.id]);
  });

  it('persisted JSON includes notification settings', async () => {
    state.updateNotificationSettings(null, { enabled: true });

    await vi.advanceTimersByTimeAsync(500);
    const data = JSON.parse(lastWrittenData);

    expect(data.notificationSettings.global.enabled).toBe(true);
  });
});

// ==========================================
// Group 3: flushState() behavior
// ==========================================

describe('flushState behavior', () => {
  it('flushState clears pending debounce and writes immediately', async () => {
    state.addProject({ name: 'P', path: '/p' });
    // Don't advance timer — flush immediately
    await state.flushState();

    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('flushState is a no-op when state is clean', async () => {
    // load() with ENOENT = clean state, no mutations
    rename.mockClear();
    await state.flushState();

    expect(rename).not.toHaveBeenCalled();
  });

  it('flushState after timer already fired does not double-write', async () => {
    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500); // timer fires
    expect(rename).toHaveBeenCalledTimes(1);

    rename.mockClear();
    await state.flushState();
    expect(rename).not.toHaveBeenCalled();
  });
});

// ==========================================
// Group 4: Write failure and retry
// ==========================================

describe('write failure and retry', () => {
  it('write failure re-marks dirty and schedules retry', async () => {
    mockFileHandle.writeFile.mockRejectedValueOnce(new Error('disk full'));
    mockFileHandle.writeFile.mockImplementation(async (data) => { lastWrittenData = data; });

    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500); // first write — fails
    expect(rename).not.toHaveBeenCalled(); // write failed before rename

    await vi.advanceTimersByTimeAsync(500); // retry fires
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

// ==========================================
// Group 5: Atomic write mechanics
// ==========================================

describe('atomic write mechanics', () => {
  it('writes to temp file, syncs, then renames to primary', async () => {
    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500);

    expect(open).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.sync).toHaveBeenCalledTimes(1);
    expect(mockFileHandle.close).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('creates backup of primary before rename', async () => {
    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500);

    expect(copyFile).toHaveBeenCalledTimes(1);
  });

  it('skips backup gracefully on first write when no primary exists', async () => {
    copyFile.mockRejectedValueOnce(new Error('ENOENT'));
    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500);

    // Should still complete the rename successfully
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

// ==========================================
// Group 6: Partial write recovery
// ==========================================

describe('partial write recovery', () => {
  it('does not corrupt primary if write to temp fails', async () => {
    mockFileHandle.writeFile.mockRejectedValueOnce(new Error('disk full'));
    mockFileHandle.writeFile.mockImplementation(async (data) => { lastWrittenData = data; });

    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500);

    // rename should NOT have been called (write failed before rename)
    expect(rename).not.toHaveBeenCalled();
  });

  it('does not corrupt primary if fsync fails', async () => {
    mockFileHandle.sync.mockRejectedValueOnce(new Error('IO error'));

    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500);

    expect(rename).not.toHaveBeenCalled();
  });

  it('retries after partial write failure', async () => {
    mockFileHandle.writeFile.mockRejectedValueOnce(new Error('disk full'));
    mockFileHandle.writeFile.mockImplementation(async (data) => { lastWrittenData = data; });

    state.addProject({ name: 'P', path: '/p' });
    await vi.advanceTimersByTimeAsync(500); // first attempt fails
    await vi.advanceTimersByTimeAsync(500); // retry

    expect(rename).toHaveBeenCalledTimes(1); // succeeds on retry
  });
});

// ==========================================
// Group 7: CRUD edge cases
// ==========================================

describe('CRUD edge cases', () => {
  it('addTask returns task with all expected default fields', () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const t = state.addTask({ projectId: proj.id, title: 'T', description: 'D' });

    expect(typeof t.id).toBe('string');
    expect(t.status).toBe('proposed');
    expect(t.plan).toBeNull();
    expect(t.commitHash).toBeNull();
    expect(t.costUsd).toBe(0);
    expect(typeof t.createdAt).toBe('number');
    expect(typeof t.sortOrder).toBe('number');
    expect(t.effort).toBe('medium');
  });

  it('addTask with explicit effort preserves it', () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const t = state.addTask({ projectId: proj.id, title: 'T', effort: 'large' });

    expect(t.effort).toBe('large');
  });

  it('updateTask merges partial updates', () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const t = state.addTask({ projectId: proj.id, title: 'Original Title' });
    state.updateTask(t.id, { status: 'planned', plan: 'my plan' });

    const updated = state.getTask(t.id);
    expect(updated.status).toBe('planned');
    expect(updated.plan).toBe('my plan');
    expect(updated.title).toBe('Original Title');
  });

  it('updateTask returns null for nonexistent task ID', () => {
    expect(state.updateTask('nonexistent', { status: 'done' })).toBeNull();
  });

  it('removeTask returns true and removes from tasks map', () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const t = state.addTask({ projectId: proj.id, title: 'T' });

    const result = state.removeTask(t.id);
    expect(result).toBe(true);
    expect(state.getTask(t.id)).toBeUndefined();
  });

  it('removeTask returns false for nonexistent task', () => {
    expect(state.removeTask('nonexistent')).toBe(false);
  });

  it('removeTask also removes task from its project queue', () => {
    const proj = state.addProject({ name: 'P', path: '/p' });
    const t = state.addTask({ projectId: proj.id, title: 'T' });
    state.enqueueTask(proj.id, t.id);
    expect(state.getQueue(proj.id)).toEqual([t.id]);

    state.removeTask(t.id);
    expect(state.getQueue(proj.id)).toEqual([]);
  });

  it('getTasks filters by projectId', () => {
    const proj1 = state.addProject({ name: 'P1', path: '/p1' });
    const proj2 = state.addProject({ name: 'P2', path: '/p2' });
    const t1 = state.addTask({ projectId: proj1.id, title: 'T1' });
    const t2 = state.addTask({ projectId: proj2.id, title: 'T2' });

    const proj1Tasks = state.getTasks(proj1.id);
    expect(proj1Tasks).toHaveLength(1);
    expect(proj1Tasks[0].id).toBe(t1.id);

    const allTasks = state.getTasks();
    expect(allTasks).toHaveLength(2);
  });

  it('getQueue returns empty array for unknown project', () => {
    expect(state.getQueue('nonexistent')).toEqual([]);
  });
});
