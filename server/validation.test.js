import { describe, it, expect, vi } from 'vitest';
import { isValidUUID, validateStringField, validateEnum, validateBody } from './validation.js';

describe('isValidUUID', () => {
  it('accepts valid v4 UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
  });

  it('accepts mixed-case UUIDs', () => {
    expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidUUID(123)).toBe(false);
    expect(isValidUUID(null)).toBe(false);
    expect(isValidUUID(undefined)).toBe(false);
  });

  it('rejects partial UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4')).toBe(false);
  });

  it('rejects strings with wrong format', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false); // no dashes
  });

  it('rejects SQL injection strings', () => {
    expect(isValidUUID("'; DROP TABLE tasks; --")).toBe(false);
  });
});

describe('validateStringField', () => {
  it('returns null for valid strings within limit', () => {
    expect(validateStringField('hello', 'title', { maxLength: 200 })).toBeNull();
  });

  it('returns error when exceeding maxLength', () => {
    const err = validateStringField('x'.repeat(201), 'title', { maxLength: 200 });
    expect(err).toBe('title must be 200 characters or fewer');
  });

  it('returns null for undefined when not required', () => {
    expect(validateStringField(undefined, 'title')).toBeNull();
  });

  it('returns null for null when not required', () => {
    expect(validateStringField(null, 'title')).toBeNull();
  });

  it('returns error for undefined when required', () => {
    expect(validateStringField(undefined, 'title', { required: true })).toBe('title is required');
  });

  it('returns error for empty string when required', () => {
    expect(validateStringField('', 'title', { required: true })).toBe('title is required');
  });

  it('returns error for non-string values', () => {
    expect(validateStringField(42, 'title')).toBe('title must be a string');
    expect(validateStringField(true, 'title')).toBe('title must be a string');
  });

  it('uses default maxLength of 5000', () => {
    expect(validateStringField('x'.repeat(5000), 'desc')).toBeNull();
    expect(validateStringField('x'.repeat(5001), 'desc')).toBe('desc must be 5000 characters or fewer');
  });
});

describe('validateEnum', () => {
  const allowed = ['small', 'medium', 'large'];

  it('returns null for valid value', () => {
    expect(validateEnum('small', 'effort', allowed)).toBeNull();
  });

  it('returns error for invalid value', () => {
    const err = validateEnum('huge', 'effort', allowed);
    expect(err).toBe('effort must be one of: small, medium, large');
  });

  it('returns error for empty string', () => {
    expect(validateEnum('', 'effort', allowed)).toBe('effort must be one of: small, medium, large');
  });

  it('returns null for undefined (optional)', () => {
    expect(validateEnum(undefined, 'effort', allowed)).toBeNull();
  });

  it('returns null for null (optional)', () => {
    expect(validateEnum(null, 'effort', allowed)).toBeNull();
  });
});

describe('validateBody', () => {
  function createMocks(body) {
    const req = { body };
    const res = {
      _status: null,
      _json: null,
      status(code) { this._status = code; return this; },
      json(data) { this._json = data; },
    };
    const next = vi.fn();
    return { req, res, next };
  }

  it('calls next for valid body', () => {
    const mw = validateBody({ name: { type: 'string', required: true } });
    const { req, res, next } = createMocks({ name: 'hello' });
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBeNull();
  });

  it('returns 400 for missing required field', () => {
    const mw = validateBody({ name: { type: 'string', required: true } });
    const { req, res, next } = createMocks({});
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('name is required');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for empty string on required field', () => {
    const mw = validateBody({ name: { type: 'string', required: true } });
    const { req, res, next } = createMocks({ name: '' });
    mw(req, res, next);
    expect(res._status).toBe(400);
  });

  it('returns 400 for wrong type', () => {
    const mw = validateBody({ count: { type: 'number' } });
    const { req, res, next } = createMocks({ count: 'abc' });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('count must be a number');
  });

  it('returns 400 for NaN number', () => {
    const mw = validateBody({ budget: { type: 'number' } });
    const { req, res, next } = createMocks({ budget: NaN });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('budget must be a valid number');
  });

  it('returns 400 for invalid enum value', () => {
    const mw = validateBody({ size: { type: 'string', enum: ['s', 'm', 'l'] } });
    const { req, res, next } = createMocks({ size: 'xl' });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('size must be one of: s, m, l');
  });

  it('returns 400 for exceeding maxLength', () => {
    const mw = validateBody({ name: { type: 'string', maxLength: 5 } });
    const { req, res, next } = createMocks({ name: 'toolong' });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('name must be 5 characters or fewer');
  });

  it('returns 400 for numeric min violation', () => {
    const mw = validateBody({ age: { type: 'number', min: 0 } });
    const { req, res, next } = createMocks({ age: -1 });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('age must be at least 0');
  });

  it('returns 400 for numeric max violation', () => {
    const mw = validateBody({ age: { type: 'number', max: 100 } });
    const { req, res, next } = createMocks({ age: 101 });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('age must be at most 100');
  });

  it('skips absent optional fields', () => {
    const mw = validateBody({ name: { type: 'string' }, age: { type: 'number' } });
    const { req, res, next } = createMocks({});
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('handles missing req.body', () => {
    const mw = validateBody({ name: { type: 'string' } });
    const { req, res, next } = createMocks(undefined);
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('validates array type', () => {
    const mw = validateBody({ ids: { type: 'array', required: true } });
    const { req, res, next } = createMocks({ ids: 'not-array' });
    mw(req, res, next);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe('ids must be an array');
  });

  it('accepts valid array', () => {
    const mw = validateBody({ ids: { type: 'array', required: true } });
    const { req, res, next } = createMocks({ ids: [1, 2] });
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
