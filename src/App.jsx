import { useState, useEffect, useCallback, useRef } from 'react';
import { api, WebSocketManager } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import GenerateBar from './components/GenerateBar.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import CardModal from './components/CardModal.jsx';
import PlatesSpinning from './components/PlatesSpinning.jsx';

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
  const [agentCensus, setAgentCensus] = useState(null);

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
      case 'task:created':
        setTasks((prev) => [...prev, data]);
        break;
      case 'task:dismissed':
        setTasks((prev) => prev.filter((t) => t.id !== data.id));
        setPlanStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.id];
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
        setGeneratingMap((prev) => ({
          ...prev,
          [data.projectId]: { ...prev[data.projectId], bytesReceived: data.bytesReceived },
        }));
        break;
      case 'generation:completed': {
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
        setPlanStartTimes((prev) => ({ ...prev, [data.taskId]: Date.now() }));
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: 'planning', progress: 0 } : t))
        );
        break;
      case 'planning:progress':
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, progress: data.bytesReceived } : t))
        );
        break;
      case 'planning:completed':
        setPlanStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: 'planned', plan: data.plan, plannedBy: data.plannedBy, progress: 0 }
              : t
          )
        );
        break;
      case 'planning:failed':
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
        setExecStartTimes((prev) => ({ ...prev, [data.taskId]: Date.now() }));
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, status: 'executing', progress: 0 } : t))
        );
        break;
      case 'execution:progress':
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, progress: data.bytesReceived } : t))
        );
        break;
      case 'execution:git':
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, gitSummary: data.summary, gitFiles: data.files } : t))
        );
        break;
      case 'execution:git-untracked':
        setTasks((prev) =>
          prev.map((t) => (t.id === data.taskId ? { ...t, gitUntracked: data.files } : t))
        );
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
        setExecStartTimes((prev) => {
          const next = { ...prev };
          delete next[data.taskId];
          return next;
        });
        setTasks((prev) =>
          prev.map((t) =>
            t.id === data.taskId
              ? { ...t, status: 'done', commitHash: data.commitHash, agentLog: data.agentLog }
              : t
          )
        );
        break;
      case 'execution:failed':
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
        setTestStatusMap((prev) => ({
          ...prev,
          [data.projectId]: { running: true },
        }));
        break;
      case 'project:test-completed':
        setTestStatusMap((prev) => ({
          ...prev,
          [data.projectId]: {
            running: false,
            result: { passed: data.passed, summary: data.summary, output: data.output, checkedAt: Date.now() },
          },
        }));
        break;
      case 'project:railway-checking':
        setRailwayStatusMap((prev) => ({
          ...prev,
          [data.projectId]: { ...prev[data.projectId], status: 'checking' },
        }));
        break;
      case 'project:railway-status':
        setRailwayStatusMap((prev) => ({
          ...prev,
          [data.projectId]: {
            status: data.healthy ? 'healthy' : 'failed',
            message: data.message,
            checkedAt: data.timestamp || Date.now(),
          },
        }));
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
        setSetupMap((prev) => ({
          ...prev,
          [data.projectId]: { ...prev[data.projectId], bytesReceived: data.bytesReceived },
        }));
        break;
      case 'setup-tests:completed':
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
        setAgentCensus(data);
        break;
    }
  }, []);

  useEffect(() => {
    const manager = new WebSocketManager(handleWsMessage);
    wsRef.current = manager;
    return () => manager.disconnect();
  }, [handleWsMessage]);

  const handleAddProject = async ({ name, path }) => {
    try {
      await api.addProject({ name, path });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleRemoveProject = async (id) => {
    try {
      await api.removeProject(id);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  };

  const handleUpdateProjectUrl = async (id, url) => {
    try {
      await api.updateProject(id, { url });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  };

  const handleGenerate = async (modelId, promptContent) => {
    try {
      await api.generate(selectedProjectId, selectedTemplateId, modelId, promptContent);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  };

  const handleCreateTemplate = async ({ name, content }) => {
    try {
      const created = await api.createTemplate({ name, content });
      setTemplates((prev) => [...prev, created]);
      setSelectedTemplateId(created.id);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleDeleteTemplate = async (id) => {
    try {
      await api.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      if (selectedTemplateId === id) setSelectedTemplateId('builtin:pareto-simple');
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handlePlan = async (taskId, modelId) => {
    try {
      await api.planTask(taskId, modelId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleExecute = async (taskId, modelId) => {
    try {
      await api.executeTask(taskId, modelId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleDismiss = async (taskId) => {
    try {
      await api.dismissTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
    }
  };

  const handleAbort = async (taskId) => {
    try {
      await api.abortTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleDequeue = async (taskId) => {
    try {
      await api.dequeueTask(taskId);
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const handleCreateFixTask = async (projectId, summary, output) => {
    try {
      await api.createFixTask(projectId, { summary, output });
    } catch (err) {
      setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => setStatusMessage(null), 3000);
    }
  };

  const filteredTasks = selectedProjectId
    ? tasks.filter((t) => t.projectId === selectedProjectId)
    : tasks;

  const hasPreview = selectedProject?.url;

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => { setSelectedProjectId(id); setActiveTab('board'); }}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        onUpdateProjectUrl={handleUpdateProjectUrl}
        setupMap={setupMap}
        setupResultMap={setupResultMap}
        onClearSetupResult={(id) => setSetupResultMap((prev) => { const next = { ...prev }; delete next[id]; return next; })}
        onCreateFixTask={handleCreateFixTask}
        testStatusMap={testStatusMap}
        railwayStatusMap={railwayStatusMap}
        onClearTestResult={(id) => setTestStatusMap((prev) => { const next = { ...prev }; delete next[id]; return next; })}
      />
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
            models={models}
          />
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
      <CardModal
        task={selectedTask}
        project={selectedTask ? projects.find((p) => p.id === selectedTask.projectId) : null}
        onClose={() => setSelectedTask(null)}
        onExecute={handleExecute}
        onPlan={handlePlan}
        onDismiss={handleDismiss}
        onAbort={handleAbort}
        onDequeue={handleDequeue}
        models={models}
      />
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
