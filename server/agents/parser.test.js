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

  // --- Fallback chain edge-case tests ---

  it('recovers valid objects from truncated JSON via individual-object fallback', () => {
    // First object complete, second truncated mid-string
    const input = '<task-proposals>[{"title":"Fix bug","description":"x"},{"title":"Add feat</task-proposals>';
    const result = parseGenerationOutput(input);
    // Strategy 1 (tags): JSON.parse throws on truncated array
    // Strategy 2 (array regex): no valid array match
    // Strategy 3 (individual objects): recovers the first complete object
    expect(result).toEqual([{ title: 'Fix bug', description: 'x' }]);
    expect(result).toHaveLength(1); // partial recovery confirms Strategy 3
  });

  it('handles trailing commas via individual-object fallback', () => {
    const input = '<task-proposals>[{"title":"Task A"},{"title":"Task B"},]</task-proposals>';
    const result = parseGenerationOutput(input);
    // Strategy 1 & 2 fail: trailing comma is invalid JSON
    // Strategy 3 extracts each object individually
    expect(result).toEqual([{ title: 'Task A' }, { title: 'Task B' }]);
    expect(result).toHaveLength(2);
  });

  it('uses first <task-proposals> block when multiple are present', () => {
    const input = 'Attempt 1:\n<task-proposals>[{"title":"First"}]</task-proposals>\n' +
      'Attempt 2:\n<task-proposals>[{"title":"Second"}]</task-proposals>';
    const result = parseGenerationOutput(input);
    // Non-greedy regex matches first open-to-close pair
    expect(result).toEqual([{ title: 'First' }]);
    expect(result[0].title).toBe('First');
  });

  it('returns empty array for completely empty tags', () => {
    const result = parseGenerationOutput('<task-proposals></task-proposals>');
    // Tag matches but JSON.parse('') throws; no other strategies match
    expect(result).toEqual([]);
  });

  it('finds proposals in 100KB+ output via array fallback', () => {
    const padding = 'x'.repeat(100_000);
    const json = '[{"title":"Deep task","description":"Found it"}]';
    const input = padding + '\n' + json + '\n' + padding;
    const result = parseGenerationOutput(input);
    // No tags → Strategy 2 (array regex) finds the embedded JSON array
    expect(result).toEqual([{ title: 'Deep task', description: 'Found it' }]);
    expect(result).toHaveLength(1);
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

  // --- Fallback chain edge-case tests ---

  it('parses escaped JSON via unescape fallback', () => {
    // Tag content has literal \" sequences (agent double-escaped its output)
    const tagContent = String.raw`{\"action\":\"execute\",\"targetTaskId\":\"task-1\",\"reasoning\":\"All tests pass\"}`;
    const input = `<autoclicker-decision>${tagContent}</autoclicker-decision>`;
    const result = parseJudgmentOutput(input);
    // Direct JSON.parse fails (backslash before quotes)
    // Unescape replaces \" → " then JSON.parse succeeds
    expect(result.action).toBe('execute');
    expect(result.targetTaskId).toBe('task-1');
    expect(result.reasoning).toBe('All tests pass');
  });

  it('parses escaped JSON with escaped newlines between fields', () => {
    // Tag content has literal \n between fields and \" around values
    const tagContent = String.raw`{\"action\":\"propose\",\n\"reasoning\":\"Needs work\"}`;
    const input = `<autoclicker-decision>${tagContent}</autoclicker-decision>`;
    const result = parseJudgmentOutput(input);
    // Unescape: \n → real newline (valid JSON whitespace), \" → "
    expect(result.action).toBe('propose');
    expect(result.reasoning).toBe('Needs work');
  });

  it('handles ANSI color codes wrapping JSON via last-resort regex', () => {
    const json = '{"action":"plan","targetTaskId":"t-5","reasoning":"Needs planning"}';
    const input = `<autoclicker-decision>\x1b[32m${json}\x1b[0m</autoclicker-decision>`;
    const result = parseJudgmentOutput(input);
    // Direct parse fails (ANSI prefix before {)
    // Unescape has no effect on ANSI codes
    // Last-resort regex /\{[\s\S]*"action"[\s\S]*\}/ extracts the JSON
    expect(result.action).toBe('plan');
    expect(result.targetTaskId).toBe('t-5');
    expect(result.reasoning).toBe('Needs planning');
  });

  it('rejects unexpected action enum values via validateDecision', () => {
    const input = '<autoclicker-decision>{"action":"approve","reasoning":"Looks good"}</autoclicker-decision>';
    const result = parseJudgmentOutput(input);
    // JSON parses fine, but validateDecision rejects 'approve'
    expect(result.action).toBe('skip');
    expect(result.reasoning).toBe('Invalid action: approve');
  });

  it('no-tag fallback regex ignores non-enum action values', () => {
    const input = 'Decision: {"action":"approve","reasoning":"Looks good"}';
    const result = parseJudgmentOutput(input);
    // No-tag fallback regex only matches propose|plan|execute|skip
    expect(result.action).toBe('skip');
    expect(result.reasoning).toBe('No decision tags found in output');
  });

  it('gracefully degrades to skip when tags contain unparseable prose', () => {
    const input = '<autoclicker-decision>I think we should execute task abc-123 because all tests pass</autoclicker-decision>';
    const result = parseJudgmentOutput(input);
    // All parse strategies fail on conversational text
    expect(result.action).toBe('skip');
    expect(result.reasoning).toMatch(/^Failed to parse decision JSON from:/);
    expect(result.reasoning).toContain('I think we should execute');
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

  // --- Fallback chain edge-case tests ---

  it('detects commit hash via heuristic when output says "committed"', () => {
    const input = 'Applied fix to auth module\nChanges committed abc1234f to main branch\nDone.';
    const result = parseExecutionOutput(input);
    // No tags, no JSON → Strategy 3 heuristic
    // 'committed' contains 'commit', abc1234f is 8 hex chars
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234f');
    expect(result.commitMessage).toBeNull(); // heuristic path signature
    expect(result.summary).toBeDefined();    // heuristic path includes summary
    expect(result.summary).toContain('Applied fix');
  });

  it('does not false-positive on hex hash without "commit" word', () => {
    const input = 'Deployed abc1234f to production successfully';
    const result = parseExecutionOutput(input);
    // Hex hash found but no 'commit' in text → heuristic rejects
    expect(result.success).toBe(false);
    expect(result.commitHash).toBeNull();
    expect(result.commitMessage).toBeNull();
    expect(result.summary).toContain('Deployed');
  });

  it('falls to Strategy 2 when only opening tag is present', () => {
    const input = '<execution-result>{"success":true,"commitHash":"def5678","commitMessage":"Fix login"}';
    const result = parseExecutionOutput(input);
    // Strategy 1: requires closing tag → no match
    // Strategy 2: regex finds JSON with success + commitHash keys
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('def5678');
    expect(result.commitMessage).toBe('Fix login'); // real value → NOT heuristic path
  });

  it('falls to heuristic when stderr interleaving corrupts JSON inside tags', () => {
    const input = [
      '<execution-result>{"success":true,',
      'STDERR: Warning: deprecated API usage',
      '"commitHash":"aaa1111"}</execution-result>',
    ].join('\n');
    const result = parseExecutionOutput(input);
    // Strategy 1: tags match but STDERR line breaks JSON → parse fails
    // Strategy 2: regex matches but same corruption → parse fails
    // Strategy 3: heuristic finds aaa1111 and 'commit' in 'commitHash'
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('aaa1111');
    expect(result.commitMessage).toBeNull(); // confirms heuristic path
    expect(result.summary).toContain('STDERR');
  });
});
