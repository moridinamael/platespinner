import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

describe('Execution Queue', () => {
  let project, taskA, taskB, taskC;

  beforeEach(() => {
    project = state.addProject({ name: 'test-project', path: '/tmp/test' });
    taskA = state.addTask({ projectId: project.id, title: 'Task A' });
    state.updateTask(taskA.id, { sortOrder: 100 });
    taskB = state.addTask({ projectId: project.id, title: 'Task B' });
    state.updateTask(taskB.id, { sortOrder: 200 });
    taskC = state.addTask({ projectId: project.id, title: 'Task C' });
    state.updateTask(taskC.id, { sortOrder: 300 });
  });

  afterEach(() => {
    state.clearAllQueues();
    state.removeProject(project.id);
  });

  // --- enqueueTask ---

  describe('enqueueTask', () => {
    it('enqueues a single task and returns position 1', () => {
      const len = state.enqueueTask(project.id, taskA.id);
      expect(len).toBe(1);
      expect(state.getQueue(project.id)).toEqual([taskA.id]);
    });

    it('enqueues multiple tasks in sortOrder and returns inserted position', () => {
      state.enqueueTask(project.id, taskA.id);
      const len = state.enqueueTask(project.id, taskB.id);
      expect(len).toBe(2);
      expect(state.getQueue(project.id)).toEqual([taskA.id, taskB.id]);
    });

    it('sets queuePosition on enqueued tasks', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskB.id).queuePosition).toBe(2);
    });

    it('is idempotent — re-enqueue returns existing position without duplicating', () => {
      state.enqueueTask(project.id, taskA.id);
      const len = state.enqueueTask(project.id, taskA.id);
      expect(len).toBe(1);
      expect(state.getQueue(project.id)).toEqual([taskA.id]);
    });

    it('inserts by sortOrder — lower sortOrder goes first regardless of enqueue order', () => {
      // Enqueue higher sortOrder first
      state.enqueueTask(project.id, taskC.id); // sortOrder 300
      state.enqueueTask(project.id, taskA.id); // sortOrder 100
      expect(state.getQueue(project.id)).toEqual([taskA.id, taskC.id]);
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskC.id).queuePosition).toBe(2);
    });

    it('returns the inserted position, not queue length, for priority insertion', () => {
      state.enqueueTask(project.id, taskC.id); // sortOrder 300 → position 1
      const pos = state.enqueueTask(project.id, taskA.id); // sortOrder 100 → inserts at front
      expect(pos).toBe(1); // actual position, NOT queue length 2
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskC.id).queuePosition).toBe(2);
    });

    it('returns correct position for mid-queue insertion by sortOrder', () => {
      state.enqueueTask(project.id, taskA.id); // sortOrder 100 → position 1
      state.enqueueTask(project.id, taskC.id); // sortOrder 300 → position 2
      const pos = state.enqueueTask(project.id, taskB.id); // sortOrder 200 → inserts between A and C
      expect(pos).toBe(2); // position 2, not queue length 3
      expect(state.getQueue(project.id)).toEqual([taskA.id, taskB.id, taskC.id]);
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskB.id).queuePosition).toBe(2);
      expect(state.getTask(taskC.id).queuePosition).toBe(3);
    });

    it('returns correct position when idempotently re-enqueuing a mid-queue task', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);
      // Re-enqueue taskB (already at position 2)
      const pos = state.enqueueTask(project.id, taskB.id);
      expect(pos).toBe(2); // stays at position 2, not queue length 3
    });
  });

  // --- dequeueTask ---

  describe('dequeueTask', () => {
    it('dequeues the first task (FIFO by sortOrder)', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);

      const dequeued = state.dequeueTask(project.id);
      expect(dequeued).toBe(taskA.id);
    });

    it('removes queuePosition from dequeued task', () => {
      state.enqueueTask(project.id, taskA.id);
      state.dequeueTask(project.id);
      expect(state.getTask(taskA.id).queuePosition).toBeUndefined();
    });

    it('reindexes remaining tasks after dequeue', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);
      state.dequeueTask(project.id);

      expect(state.getQueue(project.id)).toEqual([taskB.id, taskC.id]);
      expect(state.getTask(taskB.id).queuePosition).toBe(1);
      expect(state.getTask(taskC.id).queuePosition).toBe(2);
    });

    it('returns null for empty queue', () => {
      expect(state.dequeueTask(project.id)).toBeNull();
    });

    it('returns null for nonexistent project', () => {
      expect(state.dequeueTask('nonexistent-project')).toBeNull();
    });

    it('deletes queue map entry when last item is dequeued', () => {
      state.enqueueTask(project.id, taskA.id);
      state.dequeueTask(project.id);

      expect(state.getQueue(project.id)).toEqual([]);
      // getAllQueues should not contain this project
      expect(state.getAllQueues()).not.toHaveProperty(project.id);
    });
  });

  // --- removeFromQueue ---

  describe('removeFromQueue', () => {
    it('removes a task from the middle and reindexes', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);

      const removed = state.removeFromQueue(project.id, taskB.id);
      expect(removed).toBe(true);
      expect(state.getQueue(project.id)).toEqual([taskA.id, taskC.id]);
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskC.id).queuePosition).toBe(2);
      expect(state.getTask(taskB.id).queuePosition).toBeUndefined();
    });

    it('returns false for task not in queue', () => {
      expect(state.removeFromQueue(project.id, 'nonexistent-task')).toBe(false);
    });

    it('returns false for nonexistent project queue', () => {
      expect(state.removeFromQueue('nonexistent-project', taskA.id)).toBe(false);
    });

    it('deletes queue map entry when last item is removed', () => {
      state.enqueueTask(project.id, taskA.id);
      state.removeFromQueue(project.id, taskA.id);

      expect(state.getQueue(project.id)).toEqual([]);
      expect(state.getAllQueues()).not.toHaveProperty(project.id);
    });
  });

  // --- clearAllQueues ---

  describe('clearAllQueues', () => {
    it('clears all queues and returns dequeued task IDs', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);

      const cleared = state.clearAllQueues();
      expect(cleared).toContain(taskA.id);
      expect(cleared).toContain(taskB.id);
      expect(cleared).toHaveLength(2);
      expect(state.getAllQueues()).toEqual({});
    });

    it('removes queuePosition from all cleared tasks', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.clearAllQueues();

      expect(state.getTask(taskA.id).queuePosition).toBeUndefined();
      expect(state.getTask(taskB.id).queuePosition).toBeUndefined();
    });

    it('reverts tasks with plan to planned, without plan to proposed', () => {
      state.updateTask(taskA.id, { plan: 'some plan', status: 'queued' });
      state.updateTask(taskB.id, { status: 'queued' }); // no plan
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);

      state.clearAllQueues();

      expect(state.getTask(taskA.id).status).toBe('planned');
      expect(state.getTask(taskB.id).status).toBe('proposed');
    });

    it('returns empty array when no queues exist', () => {
      expect(state.clearAllQueues()).toEqual([]);
    });

    it('clears queues across multiple projects', () => {
      const project2 = state.addProject({ name: 'test-project-2', path: '/tmp/test2' });
      const taskD = state.addTask({ projectId: project2.id, title: 'Task D' });
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project2.id, taskD.id);

      const cleared = state.clearAllQueues();
      expect(cleared).toHaveLength(2);
      expect(cleared).toContain(taskA.id);
      expect(cleared).toContain(taskD.id);
      expect(state.getAllQueues()).toEqual({});

      state.removeProject(project2.id);
    });
  });

  // --- _reindexQueuePositions (tested via observable effects) ---

  describe('reindex queue positions (via multiple operations)', () => {
    it('maintains correct positions after sequential removals', () => {
      const taskD = state.addTask({ projectId: project.id, title: 'Task D' });
      state.updateTask(taskD.id, { sortOrder: 400 });

      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);
      state.enqueueTask(project.id, taskD.id);

      // Remove from middle (B at position 2)
      state.removeFromQueue(project.id, taskB.id);
      expect(state.getTask(taskA.id).queuePosition).toBe(1);
      expect(state.getTask(taskC.id).queuePosition).toBe(2);
      expect(state.getTask(taskD.id).queuePosition).toBe(3);

      // Remove from front (A at position 1)
      state.removeFromQueue(project.id, taskA.id);
      expect(state.getTask(taskC.id).queuePosition).toBe(1);
      expect(state.getTask(taskD.id).queuePosition).toBe(2);

      // Dequeue (gets C at position 1)
      const dequeued = state.dequeueTask(project.id);
      expect(dequeued).toBe(taskC.id);
      expect(state.getTask(taskD.id).queuePosition).toBe(1);

      state.removeTask(taskD.id);
    });
  });

  // --- getQueueSnapshot and getTaskQueuePosition ---

  describe('getQueueSnapshot', () => {
    it('returns snapshot with positions', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);

      const snap = state.getQueueSnapshot(project.id);
      expect(snap.projectId).toBe(project.id);
      expect(snap.queue).toEqual([
        { taskId: taskA.id, position: 1 },
        { taskId: taskB.id, position: 2 },
        { taskId: taskC.id, position: 3 },
      ]);
    });

    it('returns empty queue for nonexistent project', () => {
      const snap = state.getQueueSnapshot('nonexistent');
      expect(snap.queue).toEqual([]);
    });
  });

  describe('getTaskQueuePosition', () => {
    it('returns position info for queued task', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project.id, taskC.id);

      const pos = state.getTaskQueuePosition(taskB.id);
      expect(pos).toEqual({ projectId: project.id, position: 2, total: 3 });
    });

    it('returns null for task not in any queue', () => {
      expect(state.getTaskQueuePosition('nonexistent')).toBeNull();
    });
  });

  // --- Cross-project isolation ---

  describe('cross-project queue isolation', () => {
    let project2, taskD, taskE;

    beforeEach(() => {
      project2 = state.addProject({ name: 'test-project-2', path: '/tmp/test2' });
      taskD = state.addTask({ projectId: project2.id, title: 'Task D' });
      state.updateTask(taskD.id, { sortOrder: 100 });
      taskE = state.addTask({ projectId: project2.id, title: 'Task E' });
      state.updateTask(taskE.id, { sortOrder: 200 });
    });

    afterEach(() => {
      state.clearAllQueues();
      state.removeProject(project2.id);
    });

    it('dequeue from one project does not affect another', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project.id, taskB.id);
      state.enqueueTask(project2.id, taskD.id);
      state.enqueueTask(project2.id, taskE.id);

      state.dequeueTask(project.id);

      // project1 lost one task
      expect(state.getQueue(project.id)).toEqual([taskB.id]);
      // project2 untouched
      expect(state.getQueue(project2.id)).toEqual([taskD.id, taskE.id]);
    });

    it('getAllQueues shows both projects independently', () => {
      state.enqueueTask(project.id, taskA.id);
      state.enqueueTask(project2.id, taskD.id);

      const all = state.getAllQueues();
      expect(all[project.id]).toEqual([{ taskId: taskA.id, position: 1 }]);
      expect(all[project2.id]).toEqual([{ taskId: taskD.id, position: 1 }]);
    });
  });
});
