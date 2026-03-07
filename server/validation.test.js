import { describe, it, expect } from 'vitest';
import { isValidUUID, validateStringField, validateEnum } from './validation.js';

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
