import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { broadcast } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_ENTRIES = 200;
const DATA_DIR = join(__dirname, '..', 'data');
const LOG_FILE = join(DATA_DIR, 'activity-log.json');
const DEBOUNCE_MS = 1000;

const entries = [];
let debounceTimer = null;

function getSuggestedAction(eventType, status, extra) {
  if (status === 'failed' || status === 'aborted') return 'Retry or dismiss';
  if (status === 'test-failed') return 'Review test failures and fix';
  switch (eventType) {
    case 'generation': return 'Review proposals and plan the best ones';
    case 'planning': return 'Review plan and execute';
    case 'execution':
      if (extra?.prUrl) return 'Review PR and merge';
      return 'Check diff and merge';
    case 'ranking': return 'Review rankings and adjust order';
    case 'setup-tests': return 'Verify test command and run tests';
    case 'test':
      return extra?.passed ? 'Tests passed — ready to merge' : 'Review test failures and fix';
    default: return 'Review activity';
  }
}

export function loadActivityLog() {
  try {
    const raw = readFileSync(LOG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      entries.length = 0;
      const trimmed = parsed.slice(-MAX_ENTRIES);
      entries.push(...trimmed);
    }
  } catch {
    // File missing or corrupt — start empty
  }
}

export function recordActivity({ eventType, taskId, taskTitle, projectId, projectName, status, costUsd, durationMs, summary, extra }) {
  const entry = {
    id: randomUUID(),
    timestamp: Date.now(),
    eventType,
    taskId: taskId || null,
    taskTitle: taskTitle || null,
    projectId: projectId || null,
    projectName: projectName || null,
    status,
    costUsd: costUsd || null,
    durationMs: durationMs || null,
    summary: summary || null,
    suggestedAction: getSuggestedAction(eventType, status, extra),
    extra: extra || null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  broadcast('activity:completed', entry);
  _schedulePersist();
  return entry;
}

export function getActivityLog({ since, limit } = {}) {
  let result = entries;
  if (since !== undefined) {
    result = result.filter(e => e.timestamp >= since);
  }
  const cap = Math.min(Math.max(limit || 50, 1), MAX_ENTRIES);
  // Return newest-first
  return result.slice(-cap).reverse();
}

function _schedulePersist() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    _persistToDisk();
  }, DEBOUNCE_MS);
}

function _persistToDisk() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn('Failed to persist activity log:', err.message);
  }
}
