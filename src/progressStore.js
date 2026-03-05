// External progress store — holds transient streaming data outside React state.
// Only actively-executing/planning Cards subscribe via useSyncExternalStore,
// so progress updates don't trigger full board re-renders.

const store = {};      // Map<taskId, { bytesReceived, gitSummary?, gitFiles?, gitUntracked? }>
const listeners = {};  // Map<taskId, Set<callback>>

export function updateProgress(taskId, patch) {
  store[taskId] = { ...store[taskId], ...patch };
  listeners[taskId]?.forEach(cb => cb());
}

export function clearProgress(taskId) {
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
