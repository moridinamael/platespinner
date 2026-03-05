import { describe, it, expect } from 'vitest';
import { matchesFilters } from './utils.js';

const emptyFilters = () => ({
  search: '',
  efforts: [],
  statuses: [],
  modelId: '',
  hasPlan: false,
  dateFrom: '',
  dateTo: '',
});

const makeTask = (overrides = {}) => ({
  title: 'Default Title',
  description: 'Default description',
  rationale: 'Default rationale',
  effort: 'medium',
  status: 'proposed',
  generatedBy: 'model-a',
  plannedBy: null,
  executedBy: null,
  plan: null,
  createdAt: new Date('2025-06-15T12:00:00Z').getTime(),
  ...overrides,
});

describe('matchesFilters', () => {
  describe('search filter', () => {
    it('matches all tasks when search is empty string', () => {
      expect(matchesFilters(makeTask(), emptyFilters())).toBe(true);
    });

    it('matches case-insensitively on title', () => {
      const filters = { ...emptyFilters(), search: 'default' };
      expect(matchesFilters(makeTask({ title: 'Default Title' }), filters)).toBe(true);
    });

    it('matches on description field', () => {
      const filters = { ...emptyFilters(), search: 'unique-desc' };
      expect(matchesFilters(makeTask({ description: 'Has unique-desc here' }), filters)).toBe(true);
    });

    it('matches on rationale field', () => {
      const filters = { ...emptyFilters(), search: 'special-rationale' };
      expect(matchesFilters(makeTask({ rationale: 'special-rationale text' }), filters)).toBe(true);
    });

    it('rejects task when search term is not in any field', () => {
      const filters = { ...emptyFilters(), search: 'nonexistent' };
      expect(matchesFilters(makeTask(), filters)).toBe(false);
    });

    it('handles regex special characters in search without throwing', () => {
      const filters = { ...emptyFilters(), search: 'C++' };
      const task = makeTask({ title: 'Learn C++ basics' });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('handles parentheses in search term', () => {
      const filters = { ...emptyFilters(), search: 'task (urgent)' };
      const task = makeTask({ title: 'task (urgent) fix' });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('handles backslashes and brackets in search', () => {
      const filters1 = { ...emptyFilters(), search: 'path\\to\\file' };
      const task1 = makeTask({ title: 'path\\to\\file location' });
      expect(matchesFilters(task1, filters1)).toBe(true);

      const filters2 = { ...emptyFilters(), search: '[test]' };
      const task2 = makeTask({ title: 'run [test] suite' });
      expect(matchesFilters(task2, filters2)).toBe(true);
    });
  });

  describe('effort filter', () => {
    it('passes when efforts array is empty (filter inactive)', () => {
      expect(matchesFilters(makeTask(), emptyFilters())).toBe(true);
    });

    it('passes when task effort is in efforts array', () => {
      const filters = { ...emptyFilters(), efforts: ['small', 'medium'] };
      expect(matchesFilters(makeTask({ effort: 'medium' }), filters)).toBe(true);
    });

    it('rejects when task effort is not in efforts array', () => {
      const filters = { ...emptyFilters(), efforts: ['small'] };
      expect(matchesFilters(makeTask({ effort: 'large' }), filters)).toBe(false);
    });
  });

  describe('status filter', () => {
    it('passes when statuses array is empty', () => {
      expect(matchesFilters(makeTask(), emptyFilters())).toBe(true);
    });

    it('passes when task status is in statuses array', () => {
      const filters = { ...emptyFilters(), statuses: ['proposed', 'planned'] };
      expect(matchesFilters(makeTask({ status: 'proposed' }), filters)).toBe(true);
    });

    it('rejects when task status is not in statuses array', () => {
      const filters = { ...emptyFilters(), statuses: ['done'] };
      expect(matchesFilters(makeTask({ status: 'proposed' }), filters)).toBe(false);
    });
  });

  describe('combined effort + status filters (AND logic)', () => {
    it('matches task satisfying both effort and status filters', () => {
      const filters = { ...emptyFilters(), efforts: ['small'], statuses: ['proposed', 'planned'] };
      const task = makeTask({ effort: 'small', status: 'proposed' });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('rejects task matching status but not effort', () => {
      const filters = { ...emptyFilters(), efforts: ['small'], statuses: ['proposed', 'planned'] };
      const task = makeTask({ effort: 'large', status: 'proposed' });
      expect(matchesFilters(task, filters)).toBe(false);
    });

    it('rejects task matching effort but not status', () => {
      const filters = { ...emptyFilters(), efforts: ['small'], statuses: ['proposed', 'planned'] };
      const task = makeTask({ effort: 'small', status: 'done' });
      expect(matchesFilters(task, filters)).toBe(false);
    });

    it('further narrows when search term is added', () => {
      const filters = { ...emptyFilters(), efforts: ['small'], statuses: ['proposed'], search: 'important' };
      expect(matchesFilters(makeTask({ effort: 'small', status: 'proposed', title: 'mundane task' }), filters)).toBe(false);
      expect(matchesFilters(makeTask({ effort: 'small', status: 'proposed', title: 'important task' }), filters)).toBe(true);
    });
  });

  describe('date range boundaries', () => {
    it('dateFrom is inclusive — task created at midnight matches', () => {
      const filters = { ...emptyFilters(), dateFrom: '2025-06-15' };
      const task = makeTask({ createdAt: new Date('2025-06-15T00:00:00.000Z').getTime() });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('dateFrom excludes tasks before that date', () => {
      const filters = { ...emptyFilters(), dateFrom: '2025-06-15' };
      const task = makeTask({ createdAt: new Date('2025-06-14T23:59:59.999Z').getTime() });
      expect(matchesFilters(task, filters)).toBe(false);
    });

    it('dateTo is inclusive — task created at 23:59 on to-date matches', () => {
      const filters = { ...emptyFilters(), dateTo: '2025-06-15' };
      const task = makeTask({ createdAt: new Date('2025-06-15T23:59:59.999Z').getTime() });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('dateTo excludes tasks from the next day', () => {
      const filters = { ...emptyFilters(), dateTo: '2025-06-15' };
      const task = makeTask({ createdAt: new Date('2025-06-16T00:00:00.000Z').getTime() });
      expect(matchesFilters(task, filters)).toBe(false);
    });

    it('dateFrom === dateTo matches tasks from that entire day', () => {
      const filters = { ...emptyFilters(), dateFrom: '2025-06-15', dateTo: '2025-06-15' };
      expect(matchesFilters(makeTask({ createdAt: new Date('2025-06-15T00:00:00.000Z').getTime() }), filters)).toBe(true);
      expect(matchesFilters(makeTask({ createdAt: new Date('2025-06-15T23:59:59.999Z').getTime() }), filters)).toBe(true);
      expect(matchesFilters(makeTask({ createdAt: new Date('2025-06-14T23:59:59.999Z').getTime() }), filters)).toBe(false);
      expect(matchesFilters(makeTask({ createdAt: new Date('2025-06-16T00:00:00.000Z').getTime() }), filters)).toBe(false);
    });

    it('task with no createdAt (falsy/0) is excluded by dateFrom', () => {
      const filters = { ...emptyFilters(), dateFrom: '2025-01-01' };
      expect(matchesFilters(makeTask({ createdAt: 0 }), filters)).toBe(false);
      expect(matchesFilters(makeTask({ createdAt: undefined }), filters)).toBe(false);
    });
  });

  describe('model filter', () => {
    it('passes when modelId is empty (filter inactive)', () => {
      expect(matchesFilters(makeTask(), emptyFilters())).toBe(true);
    });

    it('matches against generatedBy', () => {
      const filters = { ...emptyFilters(), modelId: 'model-a' };
      expect(matchesFilters(makeTask({ generatedBy: 'model-a' }), filters)).toBe(true);
    });

    it('matches against plannedBy', () => {
      const filters = { ...emptyFilters(), modelId: 'model-b' };
      const task = makeTask({ generatedBy: 'model-a', plannedBy: 'model-b' });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('matches against executedBy', () => {
      const filters = { ...emptyFilters(), modelId: 'model-c' };
      const task = makeTask({ generatedBy: 'model-a', plannedBy: 'model-b', executedBy: 'model-c' });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('rejects when modelId matches none of the three fields', () => {
      const filters = { ...emptyFilters(), modelId: 'model-x' };
      const task = makeTask({ generatedBy: 'model-a', plannedBy: 'model-b', executedBy: 'model-c' });
      expect(matchesFilters(task, filters)).toBe(false);
    });
  });

  describe('hasPlan filter', () => {
    it('passes when hasPlan is false (filter inactive)', () => {
      expect(matchesFilters(makeTask({ plan: null }), emptyFilters())).toBe(true);
    });

    it('passes when hasPlan is true and task has a plan', () => {
      const filters = { ...emptyFilters(), hasPlan: true };
      expect(matchesFilters(makeTask({ plan: 'some plan text' }), filters)).toBe(true);
    });

    it('rejects when hasPlan is true and task has no plan', () => {
      const filters = { ...emptyFilters(), hasPlan: true };
      expect(matchesFilters(makeTask({ plan: null }), filters)).toBe(false);
    });
  });

  describe('all filters active simultaneously', () => {
    it('returns true when a task satisfies every filter', () => {
      const filters = {
        search: 'important',
        efforts: ['small'],
        statuses: ['proposed'],
        modelId: 'model-a',
        hasPlan: true,
        dateFrom: '2025-06-01',
        dateTo: '2025-06-30',
      };
      const task = makeTask({
        title: 'An important task',
        effort: 'small',
        status: 'proposed',
        generatedBy: 'model-a',
        plan: 'Step 1: do things',
        createdAt: new Date('2025-06-15T12:00:00Z').getTime(),
      });
      expect(matchesFilters(task, filters)).toBe(true);
    });

    it('returns empty array gracefully when no tasks match', () => {
      const filters = {
        search: 'xyz-no-match',
        efforts: ['small'],
        statuses: ['done'],
        modelId: 'model-z',
        hasPlan: true,
        dateFrom: '2025-01-01',
        dateTo: '2025-01-31',
      };
      const tasks = [
        makeTask({ title: 'Task A', effort: 'large', status: 'proposed' }),
        makeTask({ title: 'Task B', effort: 'medium', status: 'planned' }),
        makeTask({ title: 'Task C', effort: 'small', status: 'done' }),
      ];
      const result = tasks.filter((t) => matchesFilters(t, filters));
      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });
  });
});
