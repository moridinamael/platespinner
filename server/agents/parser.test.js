import { describe, it, expect } from 'vitest';
import {
  parseGenerationOutput,
  parseTestSetupOutput,
  parsePlanningOutput,
  parseJudgmentOutput,
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

describe('parseJudgmentOutput', () => {
  it('extracts decision from <autoclicker-decision> tags', () => {
    const input = `<autoclicker-decision>{"action":"execute","targetTaskId":"abc-123","reasoning":"Tests pass"}</autoclicker-decision>`;
    const result = parseJudgmentOutput(input);
    expect(result.action).toBe('execute');
    expect(result.targetTaskId).toBe('abc-123');
    expect(result.reasoning).toBe('Tests pass');
  });

  it('falls back to raw JSON when tags are missing', () => {
    const input = `Here's my decision: {"action": "execute", "targetTaskId": "abc-123", "reasoning": "Tests pass"}`;
    const result = parseJudgmentOutput(input);
    expect(result.action).toBe('execute');
    expect(result.targetTaskId).toBe('abc-123');
    expect(result.reasoning).toBe('Tests pass');
  });

  it('fallback works with surrounding conversational text', () => {
    const input = `I've analyzed the board and here is what I think:\n\n{"action": "propose", "reasoning": "Need new tasks"}\n\nLet me know if you agree.`;
    const result = parseJudgmentOutput(input);
    expect(result.action).toBe('propose');
    expect(result.reasoning).toBe('Need new tasks');
  });

  it('returns skip when no tags and no valid JSON', () => {
    const result = parseJudgmentOutput('just some random text with no decision');
    expect(result.action).toBe('skip');
    expect(result.reasoning).toBe('No decision tags found in output');
  });

  it('returns skip when JSON regex matches but parse fails', () => {
    const input = `{"action": "execute", broken json here}`;
    const result = parseJudgmentOutput(input);
    expect(result.action).toBe('skip');
    expect(result.reasoning).toBe('No decision tags found in output');
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
