import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api.js';

// Activity entry shape:
// { id: string, type: string, timestamp: number, message: string, taskId?: string, projectId?: string, ...metadata }

const STORAGE_KEY = 'kanban-activity-lastSeen';
const FADE_MS = 24 * 60 * 60 * 1000;

export function useActivityFeed() {
  const [activities, setActivities] = useState([]);
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? Number(saved) : 0;
    } catch {
      return 0;
    }
  });

  // Fetch initial activity on mount
  useEffect(() => {
    api.getActivity(50)
      .then(data => setActivities(data))
      .catch(err => console.warn('Failed to load activity feed:', err));
  }, []);

  // Filter to entries within the last 24 hours
  const visibleActivities = useMemo(
    () => activities.filter(entry => Date.now() - entry.timestamp < FADE_MS),
    [activities],
  );

  const unreadCount = useMemo(
    () => visibleActivities.filter(entry => entry.timestamp > lastSeenTimestamp).length,
    [visibleActivities, lastSeenTimestamp],
  );

  const markAllRead = useCallback(() => {
    const now = Date.now();
    setLastSeenTimestamp(now);
    localStorage.setItem(STORAGE_KEY, String(now));
  }, []);

  const dismissEntry = useCallback((entryId) => {
    setActivities(prev => prev.filter(a => a.id !== entryId));
  }, []);

  const handleActivityWsEvent = useCallback((event, data) => {
    if (event !== 'activity:completed') return;
    setActivities(prev => {
      if (prev.some(a => a.id === data.id)) return prev;
      const next = [data, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }, []);

  return {
    activities: visibleActivities,
    unreadCount,
    lastSeenTimestamp,
    markAllRead,
    dismissEntry,
    handleActivityWsEvent,
  };
}
