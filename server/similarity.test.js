import { describe, it, expect } from 'vitest';
import {
  tokenize,
  buildTFIDF,
  cosineSimilarity,
  findSimilarTasks,
  extractFilePaths,
  findFileConflicts,
} from './similarity.js';

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toEqual(['hello', 'world']);
  });

  it('strips punctuation', () => {
    const tokens = tokenize('add input-validation!');
    expect(tokens).toContain('add');
    expect(tokens).toContain('input');
    expect(tokens).toContain('validation');
  });

  it('removes stop words', () => {
    const tokens = tokenize('add the input validation to the form');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('to');
    expect(tokens).toContain('add');
    expect(tokens).toContain('input');
    expect(tokens).toContain('validation');
    expect(tokens).toContain('form');
  });

  it('filters single-character tokens', () => {
    const tokens = tokenize('a b c add');
    expect(tokens).toEqual(['add']);
  });

  it('handles empty/null input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = new Map([['add', 0.5], ['validation', 0.3]]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const vecA = new Map([['add', 1]]);
    const vecB = new Map([['remove', 1]]);
    expect(cosineSimilarity(vecA, vecB)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });
});

describe('buildTFIDF', () => {
  it('builds vectors for multiple documents', () => {
    const docs = [
      { id: 'a', text: 'add input validation' },
      { id: 'b', text: 'remove old validation' },
    ];
    const { vectors, idf } = buildTFIDF(docs);
    expect(vectors.has('a')).toBe(true);
    expect(vectors.has('b')).toBe(true);
    // 'validation' appears in both docs — lower IDF
    // 'add' appears in only doc 'a' — higher IDF
    expect(idf.get('validation')).toBeLessThan(idf.get('add'));
  });

  it('handles empty documents array', () => {
    const { vectors, idf } = buildTFIDF([]);
    expect(vectors.size).toBe(0);
    expect(idf.size).toBe(0);
  });
});

describe('findSimilarTasks', () => {
  const existingTasks = [
    { id: '1', title: 'Add input validation', description: 'Validate user inputs on forms', rationale: 'Prevent bad data', status: 'proposed' },
    { id: '2', title: 'Add dark mode', description: 'Implement dark theme support', rationale: 'Better UX at night', status: 'proposed' },
    { id: '3', title: 'Fix login bug', description: 'Users cannot log in with special characters', rationale: 'Critical bug', status: 'done' },
  ];

  it('catches semantically similar tasks', () => {
    const newTask = { title: 'Validate user inputs', description: 'Add validation to input fields', rationale: '' };
    const similar = findSimilarTasks(newTask, existingTasks, 0.2);
    expect(similar.length).toBeGreaterThan(0);
    // The "Add input validation" task should be the top match
    expect(similar[0].taskId).toBe('1');
    expect(similar[0].score).toBeGreaterThan(0.2);
  });

  it('does not flag unrelated tasks', () => {
    const newTask = { title: 'Implement webhook notifications', description: 'Send HTTP POST on task completion', rationale: '' };
    const similar = findSimilarTasks(newTask, existingTasks, 0.3);
    // None of the existing tasks are about webhooks
    expect(similar.length).toBe(0);
  });

  it('returns empty for empty existing tasks', () => {
    const newTask = { title: 'Something', description: '', rationale: '' };
    expect(findSimilarTasks(newTask, [], 0.3)).toEqual([]);
  });

  it('handles tasks with empty descriptions', () => {
    const newTask = { title: 'Add input validation', description: '', rationale: '' };
    const similar = findSimilarTasks(newTask, existingTasks, 0.2);
    expect(similar.length).toBeGreaterThan(0);
  });

  it('sorts results by score descending', () => {
    const newTask = { title: 'Validate inputs', description: 'form validation', rationale: '' };
    const similar = findSimilarTasks(newTask, existingTasks, 0.1);
    for (let i = 1; i < similar.length; i++) {
      expect(similar[i - 1].score).toBeGreaterThanOrEqual(similar[i].score);
    }
  });
});

describe('extractFilePaths', () => {
  it('extracts backtick-wrapped paths', () => {
    const text = 'Modify `server/routes/tasks.js` and `src/api.js`';
    const paths = extractFilePaths(text);
    expect(paths).toContain('server/routes/tasks.js');
    expect(paths).toContain('src/api.js');
  });

  it('extracts bare file paths', () => {
    const text = 'Files to modify:\n  server/state.js\n  src/components/Card.jsx';
    const paths = extractFilePaths(text);
    expect(paths).toContain('server/state.js');
    expect(paths).toContain('src/components/Card.jsx');
  });

  it('ignores non-file paths', () => {
    const text = 'This is just regular text without any file paths';
    const paths = extractFilePaths(text);
    expect(paths.length).toBe(0);
  });

  it('handles null/empty input', () => {
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths('')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const text = 'Edit `server/state.js` then edit server/state.js again';
    const paths = extractFilePaths(text);
    const stateCount = paths.filter(p => p === 'server/state.js').length;
    expect(stateCount).toBe(1);
  });
});

describe('findFileConflicts', () => {
  it('detects overlapping files', () => {
    const conflicts = findFileConflicts(
      'task-1',
      ['server/state.js', 'src/api.js'],
      [
        { id: 'task-2', title: 'Other task', trackedFiles: ['server/state.js', 'server/routes.js'] },
      ]
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].taskId).toBe('task-2');
    expect(conflicts[0].conflictingFiles).toEqual(['server/state.js']);
  });

  it('returns empty when no overlap', () => {
    const conflicts = findFileConflicts(
      'task-1',
      ['src/api.js'],
      [
        { id: 'task-2', title: 'Other task', trackedFiles: ['server/state.js'] },
      ]
    );
    expect(conflicts.length).toBe(0);
  });

  it('skips self', () => {
    const conflicts = findFileConflicts(
      'task-1',
      ['src/api.js'],
      [
        { id: 'task-1', title: 'Same task', trackedFiles: ['src/api.js'] },
      ]
    );
    expect(conflicts.length).toBe(0);
  });

  it('handles empty inputs', () => {
    expect(findFileConflicts('t1', [], [])).toEqual([]);
    expect(findFileConflicts('t1', null, [])).toEqual([]);
    expect(findFileConflicts('t1', ['a.js'], null)).toEqual([]);
  });
});
