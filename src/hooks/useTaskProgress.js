import { useSyncExternalStore, useCallback } from 'react';
import { subscribeProgress, getProgressSnapshot } from '../progressStore.js';

export function useTaskProgress(taskId) {
  const subscribe = useCallback(
    (cb) => subscribeProgress(taskId, cb),
    [taskId]
  );
  const getSnapshot = useCallback(
    () => getProgressSnapshot(taskId),
    [taskId]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
