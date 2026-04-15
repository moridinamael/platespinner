import { useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'kanban-project-activity-lastSeen';

function loadLastSeen() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function initLastSeen(projects) {
  const saved = loadLastSeen();
  if (Object.keys(saved).length > 0) return saved;
  // First use: mark all projects as seen so existing done tasks don't show as unread
  const init = {};
  const now = Date.now();
  for (const p of projects) {
    init[p.id] = now;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
  return init;
}

export function useProjectActivity(tasks, projects) {
  const [lastSeenMap, setLastSeenMap] = useState(() => initLastSeen(projects));

  const unreadCountByProject = useMemo(() => {
    const counts = {};
    for (const p of projects) {
      const lastSeen = lastSeenMap[p.id] || 0;
      counts[p.id] = tasks.filter(
        t => t.projectId === p.id && t.status === 'done' && (t.completedAt || t.createdAt) > lastSeen
      ).length;
    }
    return counts;
  }, [tasks, projects, lastSeenMap]);

  const markProjectSeen = useCallback((projectId) => {
    setLastSeenMap(prev => {
      const next = { ...prev, [projectId]: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const getProjectActivity = useCallback((projectId) => {
    return tasks
      .filter(t => t.projectId === projectId && t.status === 'done')
      .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
  }, [tasks]);

  return { unreadCountByProject, markProjectSeen, getProjectActivity };
}
