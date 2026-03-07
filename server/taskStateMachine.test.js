import { describe, it, expect } from 'vitest';
import { canEdit, canPlan, canExecute, canDequeue, canAbort, canRetry, STATUSES } from './taskStateMachine.js';

function makeTask(status) {
  return { id: 'test-id', status };
}

describe('canEdit', () => {
  it('allows proposed', () => expect(canEdit(makeTask('proposed')).allowed).toBe(true));
  it('allows planned', () => expect(canEdit(makeTask('planned')).allowed).toBe(true));
  it('allows failed', () => expect(canEdit(makeTask('failed')).allowed).toBe(true));
  it('rejects executing', () => {
    const r = canEdit(makeTask('executing'));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('executing');
  });
  it('rejects done', () => expect(canEdit(makeTask('done')).allowed).toBe(false));
  it('rejects queued', () => expect(canEdit(makeTask('queued')).allowed).toBe(false));
  it('rejects planning', () => expect(canEdit(makeTask('planning')).allowed).toBe(false));
});

describe('canPlan', () => {
  it('allows proposed', () => expect(canPlan(makeTask('proposed')).allowed).toBe(true));
  it('allows failed', () => expect(canPlan(makeTask('failed')).allowed).toBe(true));
  it('rejects planned', () => expect(canPlan(makeTask('planned')).allowed).toBe(false));
  it('rejects executing', () => expect(canPlan(makeTask('executing')).allowed).toBe(false));
  it('rejects done', () => expect(canPlan(makeTask('done')).allowed).toBe(false));
});

describe('canExecute', () => {
  it('allows proposed', () => expect(canExecute(makeTask('proposed')).allowed).toBe(true));
  it('allows planned', () => expect(canExecute(makeTask('planned')).allowed).toBe(true));
  it('allows failed', () => expect(canExecute(makeTask('failed')).allowed).toBe(true));
  it('rejects executing', () => expect(canExecute(makeTask('executing')).allowed).toBe(false));
  it('rejects done', () => expect(canExecute(makeTask('done')).allowed).toBe(false));
  it('rejects queued', () => expect(canExecute(makeTask('queued')).allowed).toBe(false));
});

describe('canDequeue', () => {
  it('allows queued', () => expect(canDequeue(makeTask('queued')).allowed).toBe(true));
  it('rejects proposed', () => expect(canDequeue(makeTask('proposed')).allowed).toBe(false));
  it('rejects executing', () => expect(canDequeue(makeTask('executing')).allowed).toBe(false));
});

describe('canAbort', () => {
  it('allows executing', () => expect(canAbort(makeTask('executing')).allowed).toBe(true));
  it('rejects proposed', () => expect(canAbort(makeTask('proposed')).allowed).toBe(false));
  it('rejects queued', () => expect(canAbort(makeTask('queued')).allowed).toBe(false));
});

describe('canRetry', () => {
  it('allows failed', () => expect(canRetry(makeTask('failed')).allowed).toBe(true));
  it('rejects proposed', () => expect(canRetry(makeTask('proposed')).allowed).toBe(false));
  it('rejects done', () => expect(canRetry(makeTask('done')).allowed).toBe(false));
});

describe('STATUSES', () => {
  it('contains all 7 statuses', () => {
    expect(STATUSES).toHaveLength(7);
    expect(STATUSES).toContain('proposed');
    expect(STATUSES).toContain('planning');
    expect(STATUSES).toContain('planned');
    expect(STATUSES).toContain('queued');
    expect(STATUSES).toContain('executing');
    expect(STATUSES).toContain('done');
    expect(STATUSES).toContain('failed');
  });
});
