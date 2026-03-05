import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { api, WebSocketManager } from './api.js';
import { updateProgress, clearProgress } from './progressStore.js';
import Sidebar from './components/Sidebar.jsx';
import GenerateBar from './components/GenerateBar.jsx';
import FilterBar from './components/FilterBar.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import BulkActionBar from './components/BulkActionBar.jsx';
import CardModal from './components/CardModal.jsx';
import PlatesSpinning from './components/PlatesSpinning.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [activeTab, setActiveTab] = useState('board'); // 'board' | 'preview'
  // Per-project generation tracking: Map<projectId, { startedAt, bytesReceived }>
  const [generatingMap, setGeneratingMap] = useState({});
  // Per-project test setup tracking: Map<projectId, { startedAt, bytesReceived }>
  const [setupMap, setSetupMap] = useState({});
  // Per-project test setup results: Map<projectId, { success, summary, ... }>
  const [setupResultMap, setSetupResultMap] = useState({});
  // Per-task execution start times: Map<taskId, timestamp>
  const [execStartTimes, setExecStartTimes] = useState({});
  // Per-task planning start times: Map<taskId, timestamp>
  const [planStartTimes, setPlanStartTimes] = useState({});
  // Per-project test status: Map<projectId, { running: boolean, result?: { passed, summary, output } }>
  const [testStatusMap, setTestStatusMap] = useState({});
  // Per-project Railway status: Map<projectId, { status: 'unknown'|'checking'|'healthy'|'failed', message: string, checkedAt: number }>
  const [railwayStatusMap, setRailwayStatusMap] = useState({});
  const [statusMessage, setStatusMessage] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('builtin:pareto-simple');
  const wsRef = useRef(null);
  // Batched progress updates for generation and setup-tests (flushed every ~200ms)
  const pendingProgressRef = useRef({ generating: {}, setup: {} });
  const flushTimerRef = useRef(null);
  const [agentCensus, setAgentCensus] = useState(null);
  const [autoclickerStatus, setAutoclickerStatus] = useState(null);
  const [notificationSettings, setNotificationSettings] = useState(null);
  const [filters, setFilters] = useState({
    search: '', efforts: [], statuses: [], modelId: '', hasPlan: false, dateFrom: '', dateTo: '',
  });
  const [selectedIds, setSelectedIds] = useState(new Set());

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const [models, setModels] = useState([]);

  // Load initial data
  useEffect(() => {
    api.getProjects().then((loaded) => {
      setProjects(loaded);
      // Hydrate testStatusMap from cached lastTestResult on each project
      const testStatuses = {};
      for (const p of loaded) {
        if (p.lastTestResult) {
          testStatuses[p.id] = {
            running: false,
            result: { passed: p.lastTestResult.passed, summary: p.lastTestResult.summary, output: p.lastTestResult.output, checkedAt: p.lastTestResult.timestamp },
          };
        }
      }
      if (Object.keys(testStatuses).length > 0) {
        setTestStatusMap(testStatuses);
      }
      // Hydrate railwayStatusMap from cached lastRailwayResult on each project
      const railwayStatuses = {};
      for (const p of loaded) {
        if (p.lastRailwayResult) {
          railwayStatuses[p.id] = {
            status: p.lastRailwayResult.healthy ? 'healthy' : 'failed',
            message: p.lastRailwayResult.message,
            checkedAt: p.lastRailwayResult.timestamp,
          };
        }
      }
      if (Object.keys(railwayStatuses).length > 0) {
        setRailwayStatusMap(railwayStatuses);
      }
    }).catch(console.error);
    api.getTemplates().then(setTemplates).catch(console.error);
    api.getModels().then(setModels).catch(console.error);
    api.getAgentStatus().then(setAgentCensus).catch(console.error);
    api.getAutoclickerStatus().then(setAutoclickerStatus).catch(() => {});
    api.getNotificationSettings().then(setNotificationSettings).catch(console.error);
    api.getTasks().then((loaded) => {
      setTasks(loaded);
      const execStarts = {};
      const planStarts = {};
      for (const t of loaded) {
        if (t.status === 'executing') execStarts[t.id] = Date.now();
        if (t.status === 'planning') planStarts[t.id] = Date.now();
      }
      setExecStartTimes(execStarts);
      setPlanStartTimes(planStarts);
    }).catch(console.error);
    // Hydrate queue positions from server
    api.getQueues().then((queues) => {
      // queues is { projectId: [{ taskId, position }], ... }
      setTasks((prev) => prev.map((t) => {
        const projectQueue = queues[t.projectId];
        if (!projectQueue) return t;
        const entry = projectQueue.find((q) => q.taskId === t.id);
        if (entry) return { ...t, queuePosition: entry.position };
        return t;
      }));
    }).catch(console.error);
  }, []);

  // Flush batched generation/setup progress to React state
  const flushProgress = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingProgressRef.current;
    const genUpdates = pending.generating;
    const setupUpdates = pending.setup;
    pending.generating = {};
    pending.setup = {};
    const hasGen = Object.keys(genUpdates).length > 0;
    const hasSetup = Object.keys(setupUpdates).length > 0;
    if (!hasGen && !hasSetup) return;
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
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = setTimeout(flushProgress, 200);
  }, [flushProgress]);

  // WebSocket connection
  const handleWsMessage = useCallback((event, data) => {
    switch (event) {
      case 'project:created':
        setProjects((prev) => [...prev, data]);
        break;
      case 'project:updated':
        setProjects((prev) => prev.map((p) => (p.id === data.id ? data : p)));
        break;
      case 'project:removed':
        setProjects((prev) => prev.filter((p) => p.id !== data.id));
        setTasks((prev) => prev.filter((t) => t.projectId !== data.id));
        setTestStatusMap((prev) => { const next = { ...prev }; delete next[data.id]; return next; });
        setRailwayStatusMap((prev) => { const next = { ...prev }; delete next[data.id]; return next; });
        break;
      case 'projects:reordered': {
        const { orderedIds } = data;
        setProjects((prev) => {
          const map = new Map(prev.map(p => [p.id, p]));
          const reordered = orderedIds.map(id => map.get(id)).filter(Boolean);
          const remaining = prev.filter(p => !orderedIds.includes(p.id));
          return [...reordered, ...remaining];
        });
        break;
      }
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

      // --- Per-project generation ---
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
        setStatusMessage(msg);
        setTimeout(() => setStatusMessage(null), 3000);
        break;
      }
      case 'generation:failed':
        delete pendingProgressRef.current.generating[data.projectId];
        setGeneratingMap((prev) => {
          const next = { ...prev };
          delete next[data.projectId];
          return next;
        });
        setStatusMessage(`Generation failed: ${data.error}`);
        setTimeout(() => setStatusMessage(null), 5000);
        break;

      // --- Planning ---
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
        setStatusMessage(`Planning failed: ${data.error}`);
        setTimeout(() => setStatusMessage(null), 5000);
        break;

      // --- Execution with stable start times ---
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
            if (t.id === data.startedTaskId) return t; // Will be updated by execution:started
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
      case 'execution:queue-updated':
        setTasks((prev) => prev.map((t) => {
          if (t.projectId !== data.projectId) return t;
          const entry = data.queue.find((q) => q.taskId === t.id);
          if (entry) return { ...t, queuePosition: entry.position };
          // Clear stale queuePosition for tasks no longer in queue
          if (t.queuePosition !== undefined) {
            const { queuePosition: _, ...rest } = t;
            return rest;
          }
          return t;
        }));
        break;
      case 'execution:completed':
        clearProgress(data.taskId);
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
                  tokenUsage: data.tokenUsage || t.tokenUsage }
              : t
          )
        );
        break;
      case 'execution:failed':
        clearProgress(data.taskId);
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
        setStatusMessage(data.aborted ? 'Task aborted' : `Execution failed: ${data.error}`);
        setTimeout(() => setStatusMessage(null), 5000);
        break;
      case 'project:test-started':
        startTransition(() => {
          setTestStatusMap((prev) => ({
            ...prev,
            [data.projectId]: { running: true },
          }));
        });
        break;
      case 'project:test-completed':
        startTransition(() => {
          setTestStatusMap((prev) => ({
            ...prev,
            [data.projectId]: {
              running: false,
              result: { passed: data.passed, summary: data.summary, output: data.output, checkedAt: Date.now() },
            },
          }));
        });
        break;
      case 'project:railway-checking':
        startTransition(() => {
          setRailwayStatusMap((prev) => ({
            ...prev,
            [data.projectId]: { ...prev[data.projectId], status: 'checking' },
          }));
        });
        break;
      case 'project:railway-status':
        startTransition(() => {
          setRailwayStatusMap((prev) => ({
            ...prev,
            [data.projectId]: {
              status: data.healthy ? 'healthy' : 'failed',
              message: data.message,
              checkedAt: data.timestamp || Date.now(),
            },
          }));
        });
        break;
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
      case 'agents:census':
        startTransition(() => {
          setAgentCensus(data);
        });
        break;
      case 'notification': {
        // Trigger browser Notification API if permission granted and document is hidden
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const titleMap = {
            'task:completed': 'Task Completed',
            'task:failed': 'Task Failed',
            'all-tasks:done': 'All Tasks Done!',
            'test:failure': 'Tests Failed',
            'budget:exceeded': 'Budget Exceeded',
            'test:notification': 'Test Notification',
          };
          const title = titleMap[data.type] || 'Kanban Notification';
          const body = data.taskTitle || data.summary || data.message || '';
          new Notification(title, {
            body: `${data.projectName}: ${body}`,
            tag: `kanban-${data.type}-${data.taskId || data.projectId}`,
            requireInteraction: data.type === 'all-tasks:done',
          });
        }
        break;
      }
      case 'notification-settings:updated':
        if (!data.projectId || data.projectId === 'global') {
          setNotificationSettings(data.settings);
        }
        break;
      case 'autoclicker:started':
      case 'autoclicker:stopped':
      case 'autoclicker:decision':
      case 'autoclicker:phase':
      case 'autoclicker:cycle-complete':
      case 'autoclicker:error':
      case 'autoclicker:project-paused':
      case 'autoclicker:project-disabled':
      case 'autoclicker:merge-conflict':
      case 'autoclicker:merge-complete':
        api.getAutoclickerStatus().then(setAutoclickerStatus).catch(() => {});
        break;
    }
  }, [scheduleFlush]);

  useEffect(() => {
    const manager = new WebSocketManager(handleWsMessage);
    wsRef.current = manager;
    return () => {
      manager.disconnect();
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [handleWsMessage]);

  const handleAddProject = useCallback(async ({ name, path }) => {
    try {
      await api.addProject({ name, path });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleRemoveProject = useCallback(async (id) => {
    try {
      await api.removeProject(id);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, []);

  const handleUpdateProjectUrl = useCallback(async (id, url) => {
    try {
      await api.updateProject(id, { url });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, []);

  const handleGenerate = useCallback(async (modelId, promptContent) => {
    try {
      await api.generate(selectedProjectId, selectedTemplateId, modelId, promptContent);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, [selectedProjectId, selectedTemplateId]);

  const handleCreateTemplate = useCallback(async ({ name, content }) => {
    try {
      const created = await api.createTemplate({ name, content });
      setTemplates((prev) => [...prev, created]);
      setSelectedTemplateId(created.id);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleDeleteTemplate = useCallback(async (id) => {
    try {
      await api.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setSelectedTemplateId((prev) => (prev === id ? 'builtin:pareto-simple' : prev));
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handlePlan = useCallback(async (taskId, modelId) => {
    try {
      await api.planTask(taskId, modelId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleExecute = useCallback(async (taskId, modelId) => {
    try {
      await api.executeTask(taskId, modelId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleDismiss = useCallback(async (taskId) => {
    try {
      await api.dismissTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, []);

  const handleAbort = useCallback(async (taskId) => {
    try {
      await api.abortTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleUpdateTask = useCallback(async (taskId, updates) => {
    try {
      const updated = await api.updateTask(taskId, updates);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setSelectedTask((prev) => (prev && prev.id === updated.id ? updated : prev));
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleDequeue = useCallback(async (taskId) => {
    try {
      await api.dequeueTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleCreateFixTask = useCallback(async (projectId, summary, output) => {
    try {
      await api.createFixTask(projectId, { summary, output });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleStartAutoclicker = useCallback(async (config) => {
    try {
      await api.startAutoclicker(config);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleUpdateNotificationSettings = useCallback(async (updates) => {
    try {
      const updated = await api.updateNotificationSettings(null, updates);
      setNotificationSettings(updated);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleTestNotification = useCallback(async () => {
    try {
      await api.testNotification();
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const handleRequestNotificationPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
  }, []);

  const handleMerge = async (taskId, strategy) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
      const result = await api.mergeTask(task.projectId, taskId, strategy || 'merge');
      setStatusMessage(result.message || 'Branch merged successfully');
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      setStatusMessage(`Merge failed: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleCreatePR = async (taskId) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    try {
      const result = await api.createPR(task.projectId, taskId);
      setStatusMessage(`PR created: ${result.prUrl}`);
      setTimeout(() => setStatusMessage(null), 5000);
    } catch (err) {
      setStatusMessage(`PR creation failed: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleReorderProjects = async (orderedIds) => {
    setProjects((prev) => {
      const map = new Map(prev.map(p => [p.id, p]));
      return orderedIds.map(id => map.get(id)).filter(Boolean);
    });
    try {
      await api.reorderProjects(orderedIds);
    } catch (err) {
      api.getProjects().then(setProjects).catch(console.error);
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleStopAutoclicker = useCallback(async () => {
    try {
      await api.stopAutoclicker();
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  // Filter persistence via localStorage
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

  // Comprehensive filtering
  const projectTasks = selectedProjectId
    ? tasks.filter((t) => t.projectId === selectedProjectId)
    : tasks;

  const filteredTasks = useMemo(() => projectTasks.filter((t) => {
    if (filters.search) {
      const s = filters.search.toLowerCase();
      const haystack = `${t.title || ''} ${t.description || ''} ${t.rationale || ''}`.toLowerCase();
      if (!haystack.includes(s)) return false;
    }
    if (filters.efforts.length > 0 && !filters.efforts.includes(t.effort)) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(t.status)) return false;
    if (filters.modelId) {
      const m = filters.modelId;
      if (t.generatedBy !== m && t.plannedBy !== m && t.executedBy !== m) return false;
    }
    if (filters.hasPlan && !t.plan) return false;
    if (filters.dateFrom) {
      const from = new Date(filters.dateFrom).getTime();
      if ((t.createdAt || 0) < from) return false;
    }
    if (filters.dateTo) {
      const to = new Date(filters.dateTo).getTime() + 86400000;
      if ((t.createdAt || 0) >= to) return false;
    }
    return true;
  }), [projectTasks, filters]);

  const filterActive = !!(filters.search || filters.efforts.length || filters.statuses.length || filters.modelId || filters.hasPlan || filters.dateFrom || filters.dateTo);

  // Clean up selection when filtered tasks change (remove IDs not visible)
  useEffect(() => {
    const visibleIds = new Set(filteredTasks.map((t) => t.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredTasks]);

  // Selection toggle
  const handleToggleSelect = useCallback((taskId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  // Bulk actions
  const handleBulkDismiss = async () => {
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && ['proposed', 'planned', 'planning', 'queued'].includes(t.status);
    });
    setSelectedIds(new Set());
    for (const id of ids) {
      try { await api.dismissTask(id); } catch (err) { console.error(err); }
    }
  };

  const handleBulkPlan = async (modelId) => {
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && t.status === 'proposed';
    });
    setSelectedIds(new Set());
    for (const id of ids) {
      try { await api.planTask(id, modelId); } catch (err) { console.error(err); }
    }
  };

  const handleBulkEffort = async (effort) => {
    const ids = [...selectedIds].filter((id) => {
      const t = tasks.find((t2) => t2.id === id);
      return t && (t.status === 'proposed' || t.status === 'planned');
    });
    for (const id of ids) {
      try { await api.updateTask(id, { effort }); } catch (err) { console.error(err); }
    }
    setSelectedIds(new Set());
  };

  // Keyboard shortcuts: Escape to clear selection, Ctrl+A to select all visible
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !selectedTask && selectedIds.size > 0) {
        setSelectedIds(new Set());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && activeTab === 'board' && !selectedTask) {
        // Only intercept if not in an input field
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        setSelectedIds(new Set(filteredTasks.map((t) => t.id)));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIds.size, selectedTask, activeTab, filteredTasks]);

  const handleSelectProject = useCallback((id) => {
    setSelectedProjectId(id);
    setActiveTab('board');
  }, []);

  const handleClearSetupResult = useCallback((id) => {
    setSetupResultMap((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  const handleClearTestResult = useCallback((id) => {
    setTestStatusMap((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  const handleCloseModal = useCallback(() => setSelectedTask(null), []);

  const handleClearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedTaskProject = useMemo(
    () => selectedTask ? projects.find((p) => p.id === selectedTask.projectId) : null,
    [selectedTask, projects]
  );

  const hasPreview = selectedProject?.url;

  return (
    <div className="app">
      <ErrorBoundary name="Sidebar" className="error-boundary-sidebar">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          onRemoveProject={handleRemoveProject}
          onUpdateProjectUrl={handleUpdateProjectUrl}
          setupMap={setupMap}
          setupResultMap={setupResultMap}
          onClearSetupResult={handleClearSetupResult}
          onCreateFixTask={handleCreateFixTask}
          testStatusMap={testStatusMap}
          railwayStatusMap={railwayStatusMap}
          onClearTestResult={handleClearTestResult}
          autoclickerStatus={autoclickerStatus}
          onStartAutoclicker={handleStartAutoclicker}
          onStopAutoclicker={handleStopAutoclicker}
          notificationSettings={notificationSettings}
          onUpdateNotificationSettings={handleUpdateNotificationSettings}
          onTestNotification={handleTestNotification}
          onRequestNotificationPermission={handleRequestNotificationPermission}
          onReorderProjects={handleReorderProjects}
          tasks={tasks}
        />
      </ErrorBoundary>
      <main className="main">
        <GenerateBar
          generatingMap={generatingMap}
          onGenerate={handleGenerate}
          statusMessage={statusMessage}
          selectedProjectId={selectedProjectId}
          projects={projects}
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          onCreateTemplate={handleCreateTemplate}
          onDeleteTemplate={handleDeleteTemplate}
          models={models}
        />
        <FilterBar
          filters={filters}
          onFiltersChange={setFilters}
          models={models}
        />
        {hasPreview && (
          <div className="tab-bar">
            <button
              className={`tab ${activeTab === 'board' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('board')}
            >
              Board
            </button>
            <button
              className={`tab ${activeTab === 'preview' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              Preview
            </button>
          </div>
        )}
        {activeTab === 'board' ? (
          <ErrorBoundary name="Board">
            <KanbanBoard
              tasks={filteredTasks}
              projects={projects}
              execStartTimes={execStartTimes}
              planStartTimes={planStartTimes}
              onExecute={handleExecute}
              onPlan={handlePlan}
              onDismiss={handleDismiss}
              onAbort={handleAbort}
              onDequeue={handleDequeue}
              onSelectTask={setSelectedTask}
              onMerge={handleMerge}
              onCreatePR={handleCreatePR}
              models={models}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              filterActive={filterActive}
            />
            {selectedIds.size > 0 && (
              <BulkActionBar
                selectedIds={selectedIds}
                tasks={tasks}
                onDismissAll={handleBulkDismiss}
                onPlanAll={handleBulkPlan}
                onChangeEffort={handleBulkEffort}
                onClearSelection={handleClearSelection}
                models={models}
              />
            )}
          </ErrorBoundary>
        ) : (
          <div className="preview-container">
            <div className="preview-toolbar">
              <span className="preview-url">{selectedProject?.url}</span>
              <a href={selectedProject?.url} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
                &#x2197;
              </a>
            </div>
            <iframe
              src={`/api/proxy?url=${encodeURIComponent(selectedProject?.url)}`}
              className="preview-iframe"
              title={`Preview: ${selectedProject?.name}`}
            />
          </div>
        )}
      </main>
      <ErrorBoundary name="Card Details">
        <CardModal
          task={selectedTask}
          project={selectedTaskProject}
          onClose={handleCloseModal}
          onExecute={handleExecute}
          onPlan={handlePlan}
          onDismiss={handleDismiss}
          onAbort={handleAbort}
          onDequeue={handleDequeue}
          onUpdateTask={handleUpdateTask}
          onMerge={handleMerge}
          onCreatePR={handleCreatePR}
          models={models}
        />
      </ErrorBoundary>
      <PlatesSpinning
        tasks={tasks}
        generatingMap={generatingMap}
        setupMap={setupMap}
        models={models}
        agentCensus={agentCensus}
      />
    </div>
  );
}
