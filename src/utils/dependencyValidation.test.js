import { describe, it, expect } from 'vitest';
import { wouldCreateCycle } from './dependencyValidation.js';

describe('wouldCreateCycle', () => {
  const tasks = [
    { id: 'A', dependencies: ['B'] },
    { id: 'B', dependencies: ['C'] },
    { id: 'C', dependencies: [] },
    { id: 'D', dependencies: [] },
  ];

  it('detects direct self-cycle', () => {
    expect(wouldCreateCycle('A', 'A', tasks)).toBe(true);
  });

  it('detects 2-hop cycle (A->B->C, adding C->A)', () => {
    // Source C wants to depend on A. A transitively depends on C (A->B->C),
    // so this would form a cycle.
    expect(wouldCreateCycle('C', 'A', tasks)).toBe(true);
  });

  it('returns false for non-cycle addition', () => {
    // A wants to depend on D. D has no deps, so no cycle.
    expect(wouldCreateCycle('A', 'D', tasks)).toBe(false);
  });

  it('handles unknown target task gracefully', () => {
    expect(wouldCreateCycle('A', 'UNKNOWN', tasks)).toBe(false);
  });

  it('handles tasks with missing dependencies array', () => {
    const malformed = [
      { id: 'X' }, // no dependencies field at all
      { id: 'Y', dependencies: null },
    ];
    expect(wouldCreateCycle('X', 'Y', malformed)).toBe(false);
  });

  it('terminates on cyclic graph data without infinite loop', () => {
    // Even if the stored graph is already cyclic, the visited set prevents
    // infinite traversal. Source 'Z' adding 'P' should evaluate quickly.
    const cyclic = [
      { id: 'P', dependencies: ['Q'] },
      { id: 'Q', dependencies: ['P'] },
      { id: 'Z', dependencies: [] },
    ];
    expect(wouldCreateCycle('Z', 'P', cyclic)).toBe(false);
  });
});
