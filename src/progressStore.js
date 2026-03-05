// External progress store — holds transient streaming data outside React state.
// Only actively-executing/planning Cards subscribe via useSyncExternalStore,
// so progress updates don't trigger full board re-renders.
//
// Updates are batched: high-frequency events (stdout chunks) accumulate in
// pendingUpdates and flush to the store every ~200ms, cutting per-card
// re-renders by 10-50x during heavy agent activity.

const store = {};      // Map<taskId, { bytesReceived, gitSummary?, gitFiles?, gitUntracked? }>
const listeners = {};  // Map<taskId, Set<callback>>
const pendingUpdates = {};  // Map<taskId, accumulated patch>
let flushTimer = null;

function flushPending() {
  flushTimer = null;
  const taskIds = Object.keys(pendingUpdates);
  if (taskIds.length === 0) return;
  for (const taskId of taskIds) {
    store[taskId] = { ...store[taskId], ...pendingUpdates[taskId] };
    delete pendingUpdates[taskId];
    listeners[taskId]?.forEach(cb => cb());
  }
}

export function updateProgress(taskId, patch) {
  pendingUpdates[taskId] = { ...pendingUpdates[taskId], ...patch };
  if (flushTimer == null) {
    flushTimer = setTimeout(flushPending, 200);
  }
}

export function clearProgress(taskId) {
  delete pendingUpdates[taskId];
  delete store[taskId];
  if (listeners[taskId]) {
    listeners[taskId].forEach(cb => cb());
  }
}

export function getProgressSnapshot(taskId) {
  return store[taskId] || null;
}

export function subscribeProgress(taskId, callback) {
  if (!listeners[taskId]) listeners[taskId] = new Set();
  listeners[taskId].add(callback);
  return () => {
    listeners[taskId].delete(callback);
    if (listeners[taskId].size === 0) delete listeners[taskId];
  };
}
