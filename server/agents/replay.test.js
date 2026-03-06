import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { writeReplayEvent, compressReplayLog, readReplayLog, getReplayMeta, REPLAY_DIR } from './replay.js';

// Use a unique entity ID per test to avoid collisions
let entityId;
let counter = 0;

beforeEach(() => {
  entityId = `test-entity-${Date.now()}-${counter++}`;
});

afterEach(() => {
  // Clean up test replay files
  try {
    const files = readdirSync(REPLAY_DIR);
    for (const f of files) {
      if (f.startsWith('test-entity-')) {
        rmSync(join(REPLAY_DIR, f), { force: true });
      }
    }
  } catch { /* dir may not exist */ }
});

describe('writeReplayEvent', () => {
  it('creates a JSONL file and appends events', () => {
    writeReplayEvent(entityId, 'planning', { type: 'prompt_sent', prompt: 'hello' });
    writeReplayEvent(entityId, 'planning', { type: 'response_received', rawResponse: 'world' });

    const filePath = join(REPLAY_DIR, `${entityId}-planning.replay.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const event1 = JSON.parse(lines[0]);
    expect(event1.type).toBe('prompt_sent');
    expect(event1.prompt).toBe('hello');
    expect(event1.id).toBeDefined();
    expect(event1.timestamp).toBeDefined();

    const event2 = JSON.parse(lines[1]);
    expect(event2.type).toBe('response_received');
    expect(event2.rawResponse).toBe('world');
  });
});

describe('readReplayLog', () => {
  it('reads events from an uncompressed JSONL file', () => {
    writeReplayEvent(entityId, 'execution', { type: 'prompt_sent', prompt: 'test' });
    writeReplayEvent(entityId, 'execution', { type: 'error', error: 'fail' });

    const events = readReplayLog(entityId, 'execution');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('prompt_sent');
    expect(events[1].type).toBe('error');
  });

  it('returns empty array for non-existent entity', () => {
    const events = readReplayLog('non-existent-entity', 'planning');
    expect(events).toEqual([]);
  });
});

describe('compressReplayLog', () => {
  it('compresses the file and removes the original', async () => {
    writeReplayEvent(entityId, 'planning', { type: 'prompt_sent', prompt: 'compress me' });

    const jsonlPath = join(REPLAY_DIR, `${entityId}-planning.replay.jsonl`);
    const gzPath = jsonlPath + '.gz';

    expect(existsSync(jsonlPath)).toBe(true);
    expect(existsSync(gzPath)).toBe(false);

    await compressReplayLog(entityId, 'planning');

    expect(existsSync(jsonlPath)).toBe(false);
    expect(existsSync(gzPath)).toBe(true);
  });

  it('compressed files can be read back', async () => {
    writeReplayEvent(entityId, 'execution', { type: 'prompt_sent', prompt: 'data' });
    writeReplayEvent(entityId, 'execution', { type: 'response_received', rawResponse: 'result' });

    await compressReplayLog(entityId, 'execution');

    const events = readReplayLog(entityId, 'execution');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('prompt_sent');
    expect(events[0].prompt).toBe('data');
    expect(events[1].type).toBe('response_received');
  });

  it('does nothing for non-existent files', async () => {
    await compressReplayLog('nonexistent', 'planning');
    // Should not throw
  });
});

describe('getReplayMeta', () => {
  it('lists available phases for an entity', () => {
    writeReplayEvent(entityId, 'planning', { type: 'prompt_sent' });
    writeReplayEvent(entityId, 'execution', { type: 'prompt_sent' });

    const phases = getReplayMeta(entityId);
    expect(phases).toContain('planning');
    expect(phases).toContain('execution');
    expect(phases).toHaveLength(2);
  });

  it('returns empty array for entity with no replay data', () => {
    const phases = getReplayMeta('nonexistent-entity');
    expect(phases).toEqual([]);
  });

  it('includes both compressed and uncompressed phases', async () => {
    writeReplayEvent(entityId, 'planning', { type: 'prompt_sent' });
    writeReplayEvent(entityId, 'execution', { type: 'prompt_sent' });

    await compressReplayLog(entityId, 'planning');

    const phases = getReplayMeta(entityId);
    expect(phases).toContain('planning');
    expect(phases).toContain('execution');
  });
});
