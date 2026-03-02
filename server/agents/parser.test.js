import { describe, it, expect } from 'vitest';
import {
  parseGenerationOutput,
  parseTestSetupOutput,
  parsePlanningOutput,
  parseExecutionOutput,
} from './parser.js';

describe('parseGenerationOutput', () => {
  it('extracts tasks from <task-proposals> tags', () => {
    const input = `Some text <task-proposals>[{"title":"Fix bug"}]</task-proposals> more text`;
    const result = parseGenerationOutput(input);
    expect(result).toEqual([{ title: 'Fix bug' }]);
  });

  it('returns empty array when no structured output found', () => {
    expect(parseGenerationOutput('just some text')).toEqual([]);
  });
});

describe('parseTestSetupOutput', () => {
  it('extracts from <test-setup-result> tags', () => {
    const input = `<test-setup-result>{"success":true,"testCommand":"npm test"}</test-setup-result>`;
    const result = parseTestSetupOutput(input);
    expect(result.success).toBe(true);
    expect(result.testCommand).toBe('npm test');
  });
});

describe('parsePlanningOutput', () => {
  it('extracts plan from <implementation-plan> tags with JSON', () => {
    const input = `<implementation-plan>{"plan":"Step 1: do things"}</implementation-plan>`;
    expect(parsePlanningOutput(input)).toBe('Step 1: do things');
  });

  it('returns raw content if plan tags contain non-JSON', () => {
    const input = `<implementation-plan>Step 1: do things</implementation-plan>`;
    expect(parsePlanningOutput(input)).toBe('Step 1: do things');
  });
});

describe('parseExecutionOutput', () => {
  it('extracts from <execution-result> tags', () => {
    const input = `<execution-result>{"success":true,"commitHash":"abc1234"}</execution-result>`;
    const result = parseExecutionOutput(input);
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
  });

  it('falls back to heuristic when no tags found', () => {
    const result = parseExecutionOutput('no structured output here');
    expect(result.success).toBe(false);
  });
});
