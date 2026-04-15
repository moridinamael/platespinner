import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { api } from '../api.js';
import { updateProgress, clearProgress } from '../progressStore.js';
import { matchesFilters } from '../utils.js';

export function useTasks({ selectedProjectId, showToast }) {
  // --- State ---
  const [tasks, setTasks] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [execStartTimes, setExecStartTimes] = useState({});
  const [planStartTimes, setPlanStartTimes] = useState({});
  const [generatingMap, setGeneratingMap] = useState({});
  const [setupMap, setSetupMap] = useState({});
  const [setupResultMap, setSetupResultMap] = useState({});
  const [rankingMap, setRankingMap] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkInFlight, setBulkInFlight] = useState(false);
  const [replayResults, setReplayResults] = useState({});
  const [logStreamVersion, setLogStreamVersion] = useState(0);
  const [filters, setFilters] = useState({
    search: '', efforts: [], statuses: [], modelId: '', hasPlan: false, dateFrom: '', dateTo: '',
  });

  // --- Refs ---
  const logBufferRef = useRef({});
  const pendingProgressRef = useRef({ generating: {}, setup: {}, ranking: {} });
  const flushTimerRef = useRef(null);
  const logFlushTimerRef = useRef(null);

  // --- Timer cleanup ---
  useEffect(() => () => {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (logFlushTimerRef.current != null) {
      clearTimeout(logFlushTimerRef.current);
      logFlushTimerRef.current = null;
    }
  }, []);

  // --- Derived values ---
  const projectTasks = useMemo(
    () => selectedProjectId
      ? tasks.filter((t) => t.projectId === selectedProjectId)
      : tasks,
    [tasks, selectedProjectId]
  );

  const filteredTasks = useMemo(
    () => projectTasks.filter((t) => matchesFilters(t, filters)),
    [projectTasks, filters]
  );

  const blockedTaskIds = useMemo(() => {
    const blocked = new Set();
    for (const task of tasks) {
      if (task.dependencies && task.dependencies.length > 0) {
        const allDepsDone = task.dependencies.every(depId => {
          const dep = tasks.find(t => t.id === depId);
          return dep && dep.status === 'done';
        });
        if (!allDepsDone) blocked.add(task.id);
      }
    }
    return blocked;
  }, [tasks]);

  const filterActive = !!(filters.search || filters.efforts.length || filters.statuses.length || filters.modelId || filters.hasPlan || filters.dateFrom || filters.dateTo);

  const hasActiveAgents = useMemo(() =>
    tasks.some(t => t.status === 'executing' || t.status === 'planning' || t.status === 'queued'),
    [tasks]
  );

  const streamingLog = selectedTask ? (logBufferRef.current[selectedTask.id] || '') : '';

  // --- Filter persistence ---
  useEffect(() => {
    const key = `kanban-filters-${selectedProjectId || 'all'}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try { setFilters(JSON.parse(saved)); } catch { /* ignore */ }
    } else {
      setFilters({ search: '', efforts: [], statuses: [], modelId: '', hasPlan: false, dateFrom: '', dateTo: '' });
    }
    setSelectedIds(new Set());
  }, [selectedProjectId]);

  useEffect(() => {
    const key = `kanban-filters-${selectedProjectId || 'all'}`;
    localStorage.setItem(key, JSON.stringify(filters));
  }, [filters, selectedProjectId]);

  // --- Selection cleanup ---
  useEffect(() => {
    const visibleIds = new Set(filteredTasks.map((t) => t.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredTasks]);

  // --- Progress flushing ---
  const flushProgress = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingProgressRef.current;
    const genUpdates = pending.generating;
    const setupUpdates = pending.setup;
    const rankingUpdates = pending.ranking;
    pending.generating = {};
    pending.setup = {};
    pending.ranking = {};
    const hasGen = Object.keys(genUpdates).length > 0;
    const hasSetup = Object.keys(setupUpdates).length > 0;
    const hasRanking = Object.keys(rankingUpdates).length > 0;
    if (!hasGen && !hasSetup && !hasRanking) return;
    startTransition(() => {
      if (hasGen) {
        setGeneratingMap(prev => {
          const next = { ...prev };
          for (const [pid, upd] of Object.entries(genUpdates)) {
            if (next[pid]) next[pid] = { ...next[pid], bytesReceived: upd.bytesReceived };
          }
          return next;
        });
      }
      if (hasSetup) {
        setSetupMap(prev => {
          const next = { ...prev };
          for (const [pid, upd] of Object.entries(setupUpdates)) {
            if (next[pid]) next[pid] = { ...next[pid], bytesReceived: upd.bytesReceived };
          }
          return next;
        });
      }
      if (hasRanking) {
        setRankingMap(prev => {
          const next = { ...prev };
          for (const [pid, upd] of Object.entries(rankingUpdates)) {
            if (next[pid]) next[pid] = { ...next[pid], bytesReceived: upd.bytesReceived };
          }
          return next;
        });
      }
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = setTimeout(flushProgress, 200);
  }, [flushProgress]);

  // --- Task CRUD callbacks ---
  const handlePlan = useCallback(async (taskId, modelId) => {
    try {
      await api.planTask(taskId, modelId);
    } catch (err) {
      showToast(`Plan failed: ${err.message}`, 'error');
    }
  }, [showToast]);

  const handleExecute = useCallback(async (taskId, modelId) => {
    try {
      await api.executeTask(taskId, modelId);
    } catch (err) {
      showToast(`Execute failed: ${err.message}`, 'error');
    }
  }, [showToast]);

  const handleDismiss = useCallback(async (taskId) => {
    try {
      await api.dismissTask(taskId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleAbort = useCallback(async (taskId) => {
    try {
      await api.abortTask(taskId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleUpdateTask = useCallback(async (taskId, updates) => {
    try {
      const updated = await api.updateTask(taskId, updates);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setSelectedTask((prev) => (prev && prev.id === updated.id ? updated : prev));
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleDequeue = useCallback(async (taskId) => {
    try {
      await api.dequeueTask(taskId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleRetry = useCallback(async (taskId) => {
    try {
      await api.retryTask(taskId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleMoveTask = useCallback(async (taskId, sourceCol, targetCol) => {
    if (sourceCol === 'proposed' && targetCol === 'plan') {
      handlePlan(taskId);
    } else if ((sourceCol === 'proposed' || sourceCol === 'plan') && targetCol === 'executing') {
      handleExecute(taskId);
    } else if (sourceCol === 'failed' && (targetCol === 'proposed' || targetCol === 'plan' || targetCol === 'executing')) {
      handleRetry(taskId);
    }
  }, [handlePlan, handleExecute, handleRetry]);

  const handleReorderTasks = useCallback(async (orderedIds) => {
    setTasks(prev => {
      const taskMap = new Map(prev.map(t => [t.id, t]));
      orderedIds.forEach((id, i) => {
        const t = taskMap.get(id);
        if (t) taskMap.set(id, { ...t, sortOrder: i });
      });
      return [...taskMap.values()];
    });
    try {
      await api.reorderTasks(orderedIds);
    } catch (err) {
      api.getTasks().then(setTasks).catch(console.error);
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleStopAll = useCallback(async () => {
    try {
      const result = await api.stopAll();
      showToast(`Stopped: ${result.aborted} aborted, ${result.dequeued} dequeued`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleMerge = useCallback(async (taskId, strategy) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
      const result = await api.mergeTask(task.projectId, taskId, strategy || 'merge');
      showToast(result.message || 'Branch merged successfully', 'success');
    } catch (err) {
      showToast(`Merge failed: ${err.message}`, 'error', 5000);
    }
  }, [tasks, showToast]);

  const handleCreatePR = useCallback(async (taskId) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
      const result = await api.createPR(task.projectId, taskId);
      showToast(`PR created: ${result.prUrl}`, 'success', 5000);
    } catch (err) {
      showToast(`PR creation failed: ${err.message}`, 'error', 5000);
    }
  }, [tasks, showToast]);

  const handleMergePR = useCallback(async (taskId, strategy) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
      const result = await api.mergePR(task.projectId, taskId, strategy || 'merge');
      showToast(result.message || 'PR merged successfully', 'success');
    } catch (err) {
      showToast(`PR merge failed: ${err.message}`, 'error', 5000);
    }
  }, [tasks, showToast]);

  const handleCreateFixTask = useCallback(async (projectId, summary, output) => {
    try {
      await api.createFixTask(projectId, { summary, output });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  // --- Batch/bulk ---
  const handlePlanAll = useCallback(async () => {
    const proposedIds = filteredTasks
      .filter(t => t.status === 'proposed')
      .map(t => t.id);
    if (proposedIds.length === 0) return;
    try {
      await api.batchAction('plan', proposedIds);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [filteredTasks, showToast]);

  const handleExecuteAll = useCallback(async () => {
    const plannedIds = filteredTasks
      .filter(t => t.status === 'planned')
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
      .map(t => t.id);
    if (plannedIds.length === 0) return;
    try {
      await api.batchAction('execute', plannedIds);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [filteredTasks, showToast]);

  const handleRankProposals = useCallback(async () => {
    const proposedTasks = filteredTasks.filter(t => t.status === 'proposed');
    if (proposedTasks.length < 2) return;
    const projectIds = [...new Set(proposedTasks.map(t => t.projectId))].filter(pid => !rankingMap[pid]);
    if (projectIds.length === 0) return;
    try {
      await Promise.all(projectIds.map(pid => api.rankProposals(pid)));
    } catch (err) {
      showToast(`Ranking failed: ${err.message}`, 'error');
    }
  }, [filteredTasks, rankingMap, showToast]);

  const handleToggleSelect = useCallback((taskId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const handleBulkDismiss = useCallback(async () => {
    if (bulkInFlight) return;
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && ['proposed', 'planned', 'planning', 'queued'].includes(t.status);
    });
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    setBulkInFlight(true);
    try {
      await api.batchAction('dismiss', ids);
    } catch (err) {
      console.error(err);
    } finally {
      setBulkInFlight(false);
    }
  }, [bulkInFlight, selectedIds, tasks]);

  const handleBulkPlan = useCallback(async (modelId) => {
    if (bulkInFlight) return;
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && t.status === 'proposed';
    });
    if (ids.length === 0) return;
    setSelectedIds(new Set());
    setBulkInFlight(true);
    try {
      await api.batchAction('plan', ids, modelId);
    } catch (err) {
      console.error(err);
    } finally {
      setBulkInFlight(false);
    }
  }, [bulkInFlight, selectedIds, tasks]);

  const handleBulkEffort = useCallback(async (effort) => {
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && (t.status === 'proposed' || t.status === 'planned');
    });
    for (const id of ids) {
      try { await api.updateTask(id, { effort }); } catch (err) { console.error(err); }
    }
    setSelectedIds(new Set());
  }, [selectedIds, tasks]);

  const handleClearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const handleCloseModal = useCallback(() => setSelectedTask(null), []);
  const handleClearSetupResult = useCallback((id) => {
    setSetupResultMap((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  // --- WebSocket event handler ---
  const handleTaskWsEvent = useCallback((event, data) => {
    switch (event) {
      // Task CRUD
      case 'task:created':
        setTasks((prev) => [...prev, data]);
        break;
      case 'task:updated':
        setTasks((prev) => prev.map((t) => (t.id === data.id ? data : t)));
        setSelectedTask((prev) => (prev && prev.id === data.id ? data : prev));
        break;
      case 'task:dismissed':
        clearProgress(data.id);
        setTasks((prev) => prev.filter((t) => t.id !== data.id));
        setPlanStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.id];
          return next;
        });
        setSelectedIds((prev) => {
          if (!prev.has(data.id)) return prev;
          const next = new Set(prev);
          next.delete(data.id);
          return next;
        });
        break;
      case 'tasks:reordered': {
        const { orderedIds } = data;
        setTasks(prev => {
          const updated = [...prev];
          for (let i = 0; i < orderedIds.length; i++) {
            const idx = updated.findIndex(t => t.id === orderedIds[i]);
            if (idx !== -1) updated[idx] = { ...updated[idx], sortOrder: i };
          }
          return updated;
        });
        break;
      }

      // Project removal — clean up tasks for removed project
      case 'project:removed':
        setTasks((prev) => prev.filter((t) => t.projectId !== data.id));
        break;

      // Ranking
      case 'ranking:started':
        setRankingMap((prev) => ({
          ...prev,
          [data.projectId]: { startedAt: Date.now(), bytesReceived: 0 },
        }));
        break;
      case 'ranking:progress':
        pendingProgressRef.current.ranking[data.projectId] = { bytesReceived: data.bytesReceived };
        scheduleFlush();
        break;
      case 'ranking:completed': {
        delete pendingProgressRef.current.ranking[data.projectId];
        setRankingMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        const count = data.rankedCount || data.rankedIds?.length || 0;
        showToast(`Ranked ${count} tasks${data.costUsd ? ` ($${data.costUsd.toFixed(4)})` : ''}`, 'success');
        break;
      }
      case 'ranking:failed':
        delete pendingProgressRef.current.ranking[data.projectId];
        setRankingMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        showToast(`Ranking failed: ${data.error}`, 'error', 5000);
        break;

      // Generation
      case 'generation:started':
        setGeneratingMap((prev) => ({
          ...prev,
          [data.projectId]: { startedAt: Date.now(), bytesReceived: 0 },
        }));
        break;
      case 'generation:progress':
        pendingProgressRef.current.generating[data.projectId] = { bytesReceived: data.bytesReceived };
        scheduleFlush();
        break;
      case 'generation:completed': {
        delete pendingProgressRef.current.generating[data.projectId];
        setGeneratingMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        const msg = data.skippedDuplicates
          ? `Generated ${data.taskCount} tasks (${data.skippedDuplicates} duplicates skipped)`
          : `Generated ${data.taskCount} tasks`;
        showToast(msg, 'success');
        break;
      }
      case 'generation:duplicates-found':
        showToast(`${data.duplicates.length} potential duplicate(s) need review`, 'info', 5000);
        break;
      case 'generation:failed':
        delete pendingProgressRef.current.generating[data.projectId];
        setGeneratingMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        showToast(`Generation failed: ${data.error}`, 'error', 5000);
        break;

      // Planning
      case 'planning:started':
        clearProgress(data.taskId);
        setPlanStartTimes((prev) => ({ ...prev, [data.taskId]: Date.now() }));
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: 'planning' } : t))
        );
        break;
      case 'planning:progress':
        updateProgress(data.taskId, { bytesReceived: data.bytesReceived });
        break;
      case 'planning:completed':
        clearProgress(data.taskId);
        delete logBufferRef.current[data.taskId];
        setPlanStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: 'planned', plan: data.plan, plannedBy: data.plannedBy,
                  costUsd: data.costUsd != null ? (t.costUsd || 0) + data.costUsd : t.costUsd }
              : t
          )
        );
        break;
      case 'planning:failed':
        clearProgress(data.taskId);
        delete logBufferRef.current[data.taskId];
        setPlanStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId ? { ...t, status: 'proposed', agentLog: data.error } : t
          )
        );
        showToast(`Planning failed: ${data.error}`, 'error', 5000);
        break;

      // Execution
      case 'execution:started':
        clearProgress(data.taskId);
        setExecStartTimes((prev) => ({ ...prev, [data.taskId]: Date.now() }));
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: 'executing' } : t))
        );
        break;
      case 'execution:progress':
        updateProgress(data.taskId, { bytesReceived: data.bytesReceived });
        break;
      case 'execution:git':
        updateProgress(data.taskId, { gitSummary: data.summary, gitFiles: data.files });
        break;
      case 'execution:git-untracked':
        updateProgress(data.taskId, { gitUntracked: data.files });
        break;
      case 'execution:queued':
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: 'queued', queuePosition: data.position } : t))
        );
        break;
      case 'execution:queue-advanced':
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id === data.startedTaskId) return t;
            const idx = data.queue?.indexOf(t.id);
            if (idx !== undefined && idx !== -1) {
              return { ...t, queuePosition: idx + 1 };
            }
            return t;
          })
        );
        break;
      case 'execution:dequeued':
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== data.taskId) return t;
            const revertStatus = t.plan ? 'planned' : 'proposed';
            return { ...t, status: revertStatus, queuePosition: undefined };
          })
        );
        break;
      case 'execution:queue-updated': {
        const queueMap = new Map(data.queue.map((q) => [q.taskId, q]));
        setTasks((prev) => prev.map((t) => {
          if (t.projectId !== data.projectId) return t;
          const entry = queueMap.get(t.id);
          if (entry) return { ...t, queuePosition: entry.position };
          if (t.queuePosition !== undefined) {
            const { queuePosition: _, ...rest } = t;
            return rest;
          }
          return t;
        }));
        break;
      }
      case 'execution:file-conflicts':
        showToast(`Warning: Task may conflict with ${data.conflicts.length} other task(s) on shared files`, 'info', 8000);
        break;
      case 'execution:completed':
        clearProgress(data.taskId);
        delete logBufferRef.current[data.taskId];
        setExecStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: 'done', commitHash: data.commitHash, agentLog: data.agentLog,
                  branch: data.branch || t.branch, baseBranch: data.baseBranch || t.baseBranch,
                  costUsd: data.costUsd != null ? (t.costUsd || 0) + data.costUsd : t.costUsd,
                  tokenUsage: data.tokenUsage || t.tokenUsage,
                  completedAt: Date.now() }
              : t
          )
        );
        break;
      case 'execution:failed':
        clearProgress(data.taskId);
        delete logBufferRef.current[data.taskId];
        setExecStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId ? { ...t, status: data.status || 'proposed', agentLog: data.error } : t
          )
        );
        showToast(data.aborted ? 'Task aborted' : `Execution failed: ${data.error}`, 'error', 5000);
        break;

      // Log streaming
      case 'log:chunk': {
        const key = data.taskId;
        logBufferRef.current[key] = (logBufferRef.current[key] || '') + data.chunk;
        if (!logFlushTimerRef.current) {
          logFlushTimerRef.current = setTimeout(() => {
            logFlushTimerRef.current = null;
            setLogStreamVersion(v => v + 1);
          }, 300);
        }
        break;
      }

      // Setup tests
      case 'setup-tests:started':
        setSetupMap((prev) => ({
          ...prev,
          [data.projectId]: { startedAt: Date.now(), bytesReceived: 0 },
        }));
        setSetupResultMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        break;
      case 'setup-tests:progress':
        pendingProgressRef.current.setup[data.projectId] = { bytesReceived: data.bytesReceived };
        scheduleFlush();
        break;
      case 'setup-tests:completed':
        delete pendingProgressRef.current.setup[data.projectId];
        setSetupMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        setSetupResultMap((prev) => ({
          ...prev,
          [data.projectId]: { success: data.success, summary: data.summary, commitHash: data.commitHash },
        }));
        break;
      case 'setup-tests:failed':
        delete pendingProgressRef.current.setup[data.projectId];
        setSetupMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        setSetupResultMap((prev) => ({
          ...prev,
          [data.projectId]: { success: false, summary: data.error },
        }));
        break;

      // Replay
      case 'replay:completed':
        setReplayResults(prev => ({ ...prev, [data.taskId]: data }));
        break;
      case 'replay:failed':
        setReplayResults(prev => ({ ...prev, [data.taskId]: { error: data.error } }));
        break;
      case 'replay:progress':
        break;

      // PR status
      case 'task:pr-status':
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, prStatus: data.prStatus }
              : t
          )
        );
        break;
      case 'pr:creation-failed':
        showToast(`Auto-PR failed: ${data.error}`, 'error', 5000);
        break;
    }
  }, [scheduleFlush, showToast]);

  return {
    // State
    tasks, setTasks, selectedTask, setSelectedTask,
    execStartTimes, setExecStartTimes, planStartTimes, setPlanStartTimes,
    generatingMap, setupMap, setupResultMap, rankingMap,
    selectedIds, setSelectedIds, bulkInFlight, replayResults,
    logStreamVersion, filters, setFilters,

    // Derived
    projectTasks, filteredTasks, blockedTaskIds,
    filterActive, hasActiveAgents, streamingLog,

    // Refs
    logBufferRef,

    // Callbacks
    handlePlan, handleExecute, handleDismiss, handleAbort,
    handleUpdateTask, handleDequeue, handleRetry, handleMoveTask,
    handleReorderTasks, handleStopAll,
    handleMerge, handleCreatePR, handleMergePR,
    handleCreateFixTask,
    handlePlanAll, handleExecuteAll, handleRankProposals,
    handleToggleSelect, handleBulkDismiss, handleBulkPlan,
    handleBulkEffort, handleClearSelection, handleCloseModal,
    handleClearSetupResult,

    // WS handler
    handleTaskWsEvent,
  };
}
