import { mkdirSync, appendFileSync, createWriteStream, createReadStream, unlinkSync, readdirSync, readFileSync } from 'fs';
import { createGzip, gunzipSync } from 'zlib';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { LOGS_DIR } from '../state.js';

export const REPLAY_DIR = join(LOGS_DIR, 'replay');

export function writeReplayEvent(entityId, phase, event) {
  mkdirSync(REPLAY_DIR, { recursive: true });
  const filename = `${entityId}-${phase}.replay.jsonl`;
  const filePath = join(REPLAY_DIR, filename);
  const line = JSON.stringify({ ...event, id: randomUUID(), timestamp: Date.now() }) + '\n';
  appendFileSync(filePath, line);
}

export async function compressReplayLog(entityId, phase) {
  const filename = `${entityId}-${phase}.replay.jsonl`;
  const filePath = join(REPLAY_DIR, filename);
  const gzPath = filePath + '.gz';
  try {
    const input = createReadStream(filePath);
    const gzip = createGzip();
    const output = createWriteStream(gzPath);
    await pipeline(input, gzip, output);
    unlinkSync(filePath);
  } catch { /* file may not exist */ }
}

export function readReplayLog(entityId, phase) {
  const jsonlPath = join(REPLAY_DIR, `${entityId}-${phase}.replay.jsonl`);
  const gzPath = jsonlPath + '.gz';

  // Try uncompressed first (in-progress or recent)
  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { /* try compressed */ }

  // Try compressed
  try {
    const content = gunzipSync(readFileSync(gzPath)).toString('utf-8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

export function getReplayMeta(entityId) {
  try {
    mkdirSync(REPLAY_DIR, { recursive: true });
    const files = readdirSync(REPLAY_DIR);
    const phases = [];
    const prefix = `${entityId}-`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const afterPrefix = f.slice(prefix.length);
      const phaseMatch = afterPrefix.match(/^(.+)\.replay\.jsonl(\.gz)?$/);
      if (phaseMatch) {
        const phase = phaseMatch[1];
        if (!phases.includes(phase)) phases.push(phase);
      }
    }
    return phases;
  } catch { return []; }
}
