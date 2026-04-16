import { useState, useEffect, useMemo, useCallback } from 'react';

export function useKeyboardShortcuts({
  selectedIds, setSelectedIds,
  selectedTask, setSelectedTask,
  activeTab,
  filteredTasks,
  commandPaletteOpen, setCommandPaletteOpen,
  activityFeedOpen, toggleActivityFeed, setActivityFeedOpen,
  handlePlan, handleExecute, handleDismiss,
}) {
  const [focusedCardIndex, setFocusedCardIndex] = useState(-1);

  const COLUMNS = useMemo(() => [
    { key: 'proposed', statuses: ['proposed'] },
    { key: 'plan', statuses: ['planning', 'planned'] },
    { key: 'executing', statuses: ['queued', 'executing'] },
    { key: 'done', statuses: ['done'] },
  ], []);

  const focusedTaskId = focusedCardIndex >= 0 && focusedCardIndex < filteredTasks.length
    ? filteredTasks[focusedCardIndex].id : null;

  const setFocusedTaskId = useCallback((taskId) => {
    const idx = filteredTasks.findIndex(t => t.id === taskId);
    if (idx >= 0) setFocusedCardIndex(idx);
  }, [filteredTasks]);

  // Reset focused index when filteredTasks change
  useEffect(() => {
    setFocusedCardIndex(prev => {
      if (prev < 0) return prev;
      if (prev >= filteredTasks.length) return -1;
      return prev;
    });
  }, [filteredTasks]);

  // Scroll focused card into view
  useEffect(() => {
    if (focusedCardIndex >= 0) {
      document.querySelector('.card-focused')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedCardIndex]);

  // Comprehensive keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Cmd/Ctrl+K: toggle command palette (always works)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(prev => !prev);
        return;
      }

      // Ctrl/Cmd+Shift+A: toggle activity feed (always works)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        toggleActivityFeed();
        return;
      }

      // Escape: priority chain (always works)
      if (e.key === 'Escape') {
        if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
          return;
        }
        if (activityFeedOpen) {
          setActivityFeedOpen(false);
          return;
        }
        if (selectedTask) {
          setSelectedTask(null);
          return;
        }
        if (selectedIds.size > 0) {
          setSelectedIds(new Set());
          return;
        }
        if (focusedCardIndex >= 0) {
          setFocusedCardIndex(-1);
          return;
        }
        return;
      }

      // Skip all other shortcuts when in input or command palette is open
      if (isInput || commandPaletteOpen) return;

      // Ctrl/Cmd+A: select all visible
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && activeTab === 'board' && !selectedTask) {
        e.preventDefault();
        setSelectedIds(new Set(filteredTasks.map((t) => t.id)));
        return;
      }

      // Skip remaining shortcuts if modal is open
      if (selectedTask) return;

      // a: toggle activity feed (works on all tabs, when no modal open)
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggleActivityFeed();
        return;
      }

      // Only work on board tab
      if (activeTab !== 'board') return;

      // Arrow Down / j: next card
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (filteredTasks.length === 0) return;
        setFocusedCardIndex(prev => prev < 0 ? 0 : (prev + 1) % filteredTasks.length);
        return;
      }

      // Arrow Up / k: previous card
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (filteredTasks.length === 0) return;
        setFocusedCardIndex(prev => prev <= 0 ? filteredTasks.length - 1 : prev - 1);
        return;
      }

      // Arrow Left / h: jump to previous column
      if (e.key === 'ArrowLeft' || e.key === 'h') {
        e.preventDefault();
        if (filteredTasks.length === 0 || focusedCardIndex < 0) return;
        const currentTask = filteredTasks[focusedCardIndex];
        const currentColIdx = COLUMNS.findIndex(c => c.statuses.includes(currentTask.status));
        for (let ci = currentColIdx - 1; ci >= 0; ci--) {
          const colTasks = filteredTasks.filter(t => COLUMNS[ci].statuses.includes(t.status));
          if (colTasks.length > 0) {
            const idx = filteredTasks.indexOf(colTasks[0]);
            setFocusedCardIndex(idx);
            return;
          }
        }
        return;
      }

      // Arrow Right / l: jump to next column
      if (e.key === 'ArrowRight' || e.key === 'l') {
        e.preventDefault();
        if (filteredTasks.length === 0 || focusedCardIndex < 0) return;
        const currentTask = filteredTasks[focusedCardIndex];
        const currentColIdx = COLUMNS.findIndex(c => c.statuses.includes(currentTask.status));
        for (let ci = currentColIdx + 1; ci < COLUMNS.length; ci++) {
          const colTasks = filteredTasks.filter(t => COLUMNS[ci].statuses.includes(t.status));
          if (colTasks.length > 0) {
            const idx = filteredTasks.indexOf(colTasks[0]);
            setFocusedCardIndex(idx);
            return;
          }
        }
        return;
      }

      // Enter: open focused card
      if (e.key === 'Enter' && focusedCardIndex >= 0) {
        e.preventDefault();
        setSelectedTask(filteredTasks[focusedCardIndex]);
        return;
      }

      // 1-4: jump to column
      if (['1', '2', '3', '4'].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const colIdx = parseInt(e.key) - 1;
        const col = COLUMNS[colIdx];
        const firstInCol = filteredTasks.findIndex(t => col.statuses.includes(t.status));
        if (firstInCol >= 0) setFocusedCardIndex(firstInCol);
        return;
      }

      // p: plan focused card
      if (e.key === 'p' && focusedCardIndex >= 0) {
        const task = filteredTasks[focusedCardIndex];
        if (task.status === 'proposed') {
          e.preventDefault();
          handlePlan(task.id);
        }
        return;
      }

      // e: execute focused card
      if (e.key === 'e' && focusedCardIndex >= 0) {
        const task = filteredTasks[focusedCardIndex];
        if (task.status === 'planned') {
          e.preventDefault();
          handleExecute(task.id);
        }
        return;
      }

      // d: dismiss focused card
      if (e.key === 'd' && focusedCardIndex >= 0) {
        const task = filteredTasks[focusedCardIndex];
        if (['proposed', 'planned'].includes(task.status)) {
          e.preventDefault();
          handleDismiss(task.id);
        }
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIds.size, selectedTask, activeTab, filteredTasks, commandPaletteOpen, activityFeedOpen, focusedCardIndex, handlePlan, handleExecute, handleDismiss, COLUMNS, setCommandPaletteOpen, setSelectedTask, setSelectedIds, toggleActivityFeed, setActivityFeedOpen]);

  return { focusedCardIndex, focusedTaskId, setFocusedTaskId, COLUMNS };
}
