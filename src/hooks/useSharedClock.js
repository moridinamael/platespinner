import { useSyncExternalStore } from 'react';

let now = Date.now();
let subscriberCount = 0;
let intervalId = null;
const listeners = new Set();

function startClock() {
  if (intervalId !== null) return;
  now = Date.now();
  intervalId = setInterval(() => {
    now = Date.now();
    listeners.forEach(cb => cb());
  }, 1000);
}

function stopClock() {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

function subscribe(callback) {
  listeners.add(callback);
  subscriberCount++;
  if (subscriberCount === 1) startClock();
  return () => {
    listeners.delete(callback);
    subscriberCount--;
    if (subscriberCount === 0) stopClock();
  };
}

function getSnapshot() {
  return now;
}

const noopSubscribe = () => () => {};
const frozenSnap = () => 0;

/**
 * Returns Date.now() that ticks every ~1 second, shared across all callers.
 * The underlying interval only runs when at least one component is subscribed.
 * Pass enabled=false to skip subscription (avoids re-renders for inactive cards).
 */
export function useSharedClock(enabled) {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? getSnapshot : frozenSnap
  );
}
