import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

// ── Mocks (hoisted before module imports) ──────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    openSync: vi.fn(() => 99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    createReadStream: vi.fn(() => {
      const { Readable } = require('stream');
      return new Readable({ read() { this.push(null); } });
    }),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: vi.fn(async () => ({
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
  };
});

vi.mock('../state.js', () => ({
  LOGS_DIR: '/tmp/fake-logs',
  getTask: vi.fn(),
  getTasks: vi.fn(() => []),
  getProject: vi.fn(),
  getProjects: vi.fn(() => []),
  updateTask: vi.fn((id, updates) => ({ id, ...updates })),
  removeTask: vi.fn(),
  lockProject: vi.fn(() => true),
  unlockProject: vi.fn(),
  enqueueTask: vi.fn(() => 1),
  getQueueSnapshot: vi.fn(() => []),
  getAllQueues: vi.fn(() => ({})),
  isTaskBlocked: vi.fn(() => false),
  getBlockers: vi.fn(() => []),
  setProcess: vi.fn(),
  getProcess: vi.fn(() => null),
  removeProcess: vi.fn(),
  markAborted: vi.fn(),
  wasAborted: vi.fn(() => false),
  clearAborted: vi.fn(),
  wouldCreateCycle: vi.fn(() => false),
  getAllExecutingTaskIds: vi.fn(() => []),
  clearAllQueues: vi.fn(() => []),
  removeFromQueue: vi.fn(),
  reorderTasks: vi.fn(),
  getDependents: vi.fn(() => []),
  addTask: vi.fn(),
  load: vi.fn(),
}));

vi.mock('../ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({
  runGeneration: vi.fn(async () => {}),
  runExecution: vi.fn(async () => {}),
  runPlanning: vi.fn(async () => {}),
  spawnAgent: vi.fn(() => ({ promise: Promise.resolve('') })),
  extractCostData: vi.fn(() => ({})),
  checkBudget: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../agents/replay.js', () => ({
  readReplayLog: vi.fn(() => []),
  getReplayMeta: vi.fn(() => []),
  REPLAY_DIR: '/tmp/fake-replay',
}));

vi.mock('../agents/cli.js', () => ({
  buildGenerationCommand: vi.fn(() => ({ cmd: 'echo', args: ['test'], useStdin: false })),
}));

vi.mock('../notifications.js', () => ({
  emitNotification: vi.fn(),
}));

vi.mock('../similarity.js', () => ({
  findSimilarTasks: vi.fn(() => []),
}));

vi.mock('../paths.js', () => ({
  toWSLPath: vi.fn((p) => p),
}));

// ── Imports (after mocks) ──────────────────────────────────────────

import router from './tasks.js';
import * as state from '../state.js';
import { broadcast } from '../ws.js';
import { runGeneration, runExecution, checkBudget } from '../agents/runner.js';
import { emitNotification } from '../notifications.js';

// ── Helpers ────────────────────────────────────────────────────────

const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    projectId: overrides.projectId || PROJECT_ID,
    title: 'Test Task',
    description: 'A test task',
    rationale: '',
    status: 'proposed',
    effort: 'small',
    plan: null,
    agentLog: null,
    commitHash: null,
    diff: null,
    branch: null,
    baseBranch: null,
    costUsd: 0,
    failureCount: 0,
    dependencies: [],
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: overrides.id || PROJECT_ID,
    name: 'Test Project',
    path: '/tmp/test-project',
    url: null,
    testCommand: null,
    budgetLimitUsd: null,
    branchStrategy: 'direct',
    sortOrder: 0,
    ...overrides,
  };
}

const app = createApp();

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// === POST /api/generate ===

describe('POST /api/generate', () => {
  it('returns 200 when project exists', async () => {
    state.getProject.mockReturnValue(makeProject());

    const res = await request(app)
      .post('/api/generate')
      .send({ projectId: PROJECT_ID });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Generation started');
    expect(res.body.projectCount).toBe(1);
  });

  it('returns 404 when project not found', async () => {
    state.getProject.mockReturnValue(null);

    const res = await request(app)
      .post('/api/generate')
      .send({ projectId: PROJECT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project not found');
  });

  it('returns 400 when no projects to generate for', async () => {
    state.getProjects.mockReturnValue([]);

    const res = await request(app)
      .post('/api/generate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No projects to generate for');
  });
});

// === PATCH /api/tasks/:id ===

describe('PATCH /api/tasks/:id', () => {
  const TASK_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('updates a proposed task successfully', async () => {
    const task = makeTask({ id: TASK_ID, status: 'proposed' });
    state.getTask.mockReturnValue(task);
    state.updateTask.mockReturnValue({ ...task, title: 'Updated' });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
  });

  it('rejects editing an executing task', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'executing' }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ title: 'Foo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch("Cannot edit task with status 'executing'");
  });

  it('returns 404 for missing task', async () => {
    state.getTask.mockReturnValue(null);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ title: 'Foo' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  it('rejects invalid effort enum', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'proposed' }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ effort: 'huge' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch('effort must be one of');
  });

  it('rejects when no editable fields provided', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'proposed' }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .send({ unknownField: 'value' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No editable fields provided');
  });
});

// === POST /api/tasks/:id/execute ===

describe('POST /api/tasks/:id/execute', () => {
  const TASK_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

  it('starts execution when lock acquired', async () => {
    const task = makeTask({ id: TASK_ID, status: 'planned' });
    state.getTask.mockReturnValue(task);
    state.getProject.mockReturnValue(makeProject());
    state.lockProject.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/execute`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Execution started');
    expect(res.body.taskId).toBe(TASK_ID);
  });

  it('enqueues when project locked', async () => {
    const task = makeTask({ id: TASK_ID, status: 'planned' });
    state.getTask.mockReturnValue(task);
    state.getProject.mockReturnValue(makeProject());
    state.lockProject.mockReturnValue(false);
    state.enqueueTask.mockReturnValue(1);
    state.getQueueSnapshot.mockReturnValue([]);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/execute`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Queued for execution');
    expect(res.body.position).toBe(1);
    expect(state.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ status: 'queued' }));
  });

  it('rejects when budget exceeded', async () => {
    const task = makeTask({ id: TASK_ID, status: 'planned' });
    state.getTask.mockReturnValue(task);
    state.getProject.mockReturnValue(makeProject({ budgetLimitUsd: 10 }));
    checkBudget.mockReturnValue({ allowed: false, totalSpent: 15, limit: 10 });

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/execute`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Budget limit exceeded');
    expect(res.body.totalSpent).toBe(15);
    expect(res.body.budgetLimit).toBe(10);
    expect(emitNotification).toHaveBeenCalledWith('budget:exceeded', expect.objectContaining({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    }));
  });

  it('rejects wrong status', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'done' }));

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/execute`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch('expected proposed, planned, or failed');
  });
});

// === POST /api/tasks/:id/dismiss ===

describe('POST /api/tasks/:id/dismiss', () => {
  const TASK_ID = 'cccccccc-1111-2222-3333-444444444444';

  it('dismisses a simple task', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'proposed' }));
    state.getProcess.mockReturnValue(null);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/dismiss`);

    expect(res.status).toBe(204);
    expect(state.removeTask).toHaveBeenCalledWith(TASK_ID);
    expect(broadcast).toHaveBeenCalledWith('task:dismissed', { id: TASK_ID });
  });

  it('kills running process before dismissing', async () => {
    const kill = vi.fn();
    const stopPolling = vi.fn();
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'executing' }));
    state.getProcess.mockReturnValue({ proc: { kill }, stopPolling });

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/dismiss`);

    expect(res.status).toBe(204);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(stopPolling).toHaveBeenCalled();
    expect(state.removeProcess).toHaveBeenCalledWith(TASK_ID);
    expect(state.removeTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('broadcasts queue update when dismissing queued task', async () => {
    state.getTask.mockReturnValue(makeTask({ id: TASK_ID, status: 'queued' }));
    state.getProcess.mockReturnValue(null);
    state.getQueueSnapshot.mockReturnValue([]);

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/dismiss`);

    expect(res.status).toBe(204);
    expect(broadcast).toHaveBeenCalledWith('execution:queue-updated', []);
  });
});

// === Invalid UUID param ===

describe('router.param UUID validation', () => {
  it('rejects non-UUID task ID', async () => {
    const res = await request(app)
      .patch('/api/tasks/not-a-uuid')
      .send({ title: 'Foo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch('Invalid task ID format');
  });
});
