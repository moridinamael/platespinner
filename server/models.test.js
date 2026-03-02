import { describe, it, expect } from 'vitest';
import { MODELS, DEFAULT_MODEL_ID, getModel } from './models.js';

describe('models', () => {
  it('exports a non-empty MODELS array', () => {
    expect(Array.isArray(MODELS)).toBe(true);
    expect(MODELS.length).toBeGreaterThan(0);
  });

  it('DEFAULT_MODEL_ID matches an existing model', () => {
    const found = MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
    expect(found).toBeDefined();
  });

  it('getModel returns correct model by id', () => {
    const model = getModel(DEFAULT_MODEL_ID);
    expect(model).toBeDefined();
    expect(model.id).toBe(DEFAULT_MODEL_ID);
  });

  it('getModel returns undefined for unknown id', () => {
    expect(getModel('nonexistent')).toBeUndefined();
  });
});
