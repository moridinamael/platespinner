import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_ENTRIES = 100;
const DATA_DIR = join(__dirname, '..', 'data');
const LOG_FILE = join(DATA_DIR, 'activity-log.json');
const DEBOUNCE_MS = 1000;

const entries = [];
let debounceTimer = null;

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

export function recordActivity({ eventType, taskId, taskTitle, projectId, projectName, status, costUsd, durationMs }) {
  const entry = {
    timestamp: Date.now(),
    eventType,
    taskId: taskId || null,
    taskTitle: taskTitle || null,
    projectId: projectId || null,
    projectName: projectName || null,
    status,
    costUsd: costUsd || null,
    durationMs: durationMs || null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  _schedulePersist();
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
