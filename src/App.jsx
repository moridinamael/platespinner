import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import GenerateBar from './components/GenerateBar.jsx';
import FilterBar from './components/FilterBar.jsx';
import KanbanBoard from './components/KanbanBoard.jsx';
import BulkActionBar from './components/BulkActionBar.jsx';
import CardModal from './components/CardModal.jsx';
import PlatesSpinning from './components/PlatesSpinning.jsx';
import ActivityFeed from './components/ActivityFeed.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import AnalyticsDashboard from './components/AnalyticsDashboard.jsx';
import SkillEditor from './components/SkillEditor.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import Toast from './components/Toast.jsx';
import { useTheme } from './hooks/useTheme.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useProjects } from './hooks/useProjects.js';
import { useTasks } from './hooks/useTasks.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useActivityFeed } from './hooks/useActivityFeed.js';

export default function App() {
  const { theme, toggleTheme } = useTheme();

  // Auth state
  const [authState, setAuthState] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);

  // Toast
  const [statusMessage, setStatusMessage] = useState(null);
  const [statusType, setStatusType] = useState('info');
  const statusTimerRef = useRef(null);

  const showToast = useCallback((text, type = 'info', duration = 3000) => {
    clearTimeout(statusTimerRef.current);
    setStatusMessage(text);
    setStatusType(type);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), duration);
  }, []);

  useEffect(() => () => clearTimeout(statusTimerRef.current), []);

  // Projects
  const {
    projects, setProjects,
    selectedProjectId, setSelectedProjectId,
    selectedProject,
    handleAddProject, handleRemoveProject,
    handleUpdateProjectUrl, handleReorderProjects,
    handleProjectWsEvent,
  } = useProjects(showToast);

  // Tasks
  const {
    tasks, setTasks, selectedTask, setSelectedTask,
    execStartTimes, setExecStartTimes, planStartTimes, setPlanStartTimes,
    generatingMap, setupMap, setupResultMap, rankingMap,
    selectedIds, setSelectedIds, bulkInFlight, replayResults,
    logStreamVersion, filters, setFilters,
    projectTasks, filteredTasks, blockedTaskIds,
    filterActive, hasActiveAgents, streamingLog,
    logBufferRef,
    handlePlan, handleExecute, handleDismiss, handleAbort,
    handleUpdateTask, handleDequeue, handleRetry, handleMoveTask,
    handleReorderTasks, handleStopAll,
    handleMerge, handleCreatePR, handleMergePR,
    handleCreateFixTask,
    handlePlanAll, handleExecuteAll, handleRankProposals,
    handleToggleSelect, handleBulkDismiss, handleBulkPlan,
    handleBulkEffort, handleClearSelection, handleCloseModal,
    handleClearSetupResult,
    handleTaskWsEvent,
  } = useTasks({ selectedProjectId, showToast });

  const {
    activities,
    unreadCount,
    lastSeenTimestamp,
    markAllRead,
    dismissEntry,
    handleActivityWsEvent,
  } = useActivityFeed();

  const [activityFeedOpen, setActivityFeedOpen] = useState(false);

  const toggleActivityFeed = useCallback(() => {
    setActivityFeedOpen(prev => {
      if (!prev) markAllRead();
      return !prev;
    });
  }, [markAllRead]);

  // App-level UI state
  const [activeTab, setActiveTab] = useState('board');
  const [models, setModels] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('builtin:pareto-simple');
  const [testStatusMap, setTestStatusMap] = useState({});
  const [railwayStatusMap, setRailwayStatusMap] = useState({});
  const [agentCensus, setAgentCensus] = useState(null);
  const [autoclickerStatus, setAutoclickerStatus] = useState(null);
  const [notificationSettings, setNotificationSettings] = useState(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);

  // Keyboard shortcuts
  const { focusedTaskId } = useKeyboardShortcuts({
    selectedIds, setSelectedIds,
    selectedTask, setSelectedTask,
    activeTab,
    filteredTasks,
    commandPaletteOpen, setCommandPaletteOpen,
    handlePlan, handleExecute, handleDismiss,
  });

  // Auth check
  useEffect(() => {
    api.authStatus().then(({ required, authenticated }) => {
      setAuthRequired(required);
      setAuthState(!required || authenticated ? 'ok' : 'login');
    }).catch(() => setAuthState('ok'));
  }, []);

  // Load initial data
  useEffect(() => {
    api.getProjects().then((loaded) => {
      setProjects(loaded);
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
    }).catch(err => showToast('Failed to load projects: ' + err.message, 'error', 5000));
    api.getTemplates().then(setTemplates).catch(console.error);
    api.getModels().then(setModels).catch(console.error);
    api.getAgentStatus().then(setAgentCensus).catch(console.error);
    api.getAutoclickerStatus().then(setAutoclickerStatus).catch(err => console.warn('Failed to load autoclicker status:', err));
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
    }).catch(err => showToast('Failed to load tasks: ' + err.message, 'error', 5000));
    api.getQueues().then((queues) => {
      const queueMap = {};
      for (const [projectId, entries] of Object.entries(queues)) {
        const m = new Map();
        for (const entry of entries) m.set(entry.taskId, entry);
        queueMap[projectId] = m;
      }
      setTasks((prev) => prev.map((t) => {
        const projectQueue = queueMap[t.projectId];
        if (!projectQueue) return t;
        const entry = projectQueue.get(t.id);
        if (entry) return { ...t, queuePosition: entry.position };
        return t;
      }));
    }).catch(console.error);
  }, []);

  // WebSocket — delegates task/project events to sub-hooks, handles app-level events
  useWebSocket({
    handleProjectWsEvent,
    handleTaskWsEvent,
    handleActivityWsEvent,
    setTestStatusMap,
    setRailwayStatusMap,
    setAgentCensus,
    setAutoclickerStatus,
    setNotificationSettings,
    showToast,
  });

  // Remaining app-level callbacks
  const handleGenerate = useCallback(async (modelId, promptContent) => {
    try {
      await api.generate(selectedProjectId, selectedTemplateId, modelId, promptContent);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [selectedProjectId, selectedTemplateId, showToast]);

  const handleCreateTemplate = useCallback(async ({ name, content }) => {
    try {
      const created = await api.createTemplate({ name, content });
      setTemplates((prev) => [...prev, created]);
      setSelectedTemplateId(created.id);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleDeleteTemplate = useCallback(async (id) => {
    try {
      await api.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setSelectedTemplateId((prev) => (prev === id ? 'builtin:pareto-simple' : prev));
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleOpenSkillEditor = useCallback((sk = null) => {
    setEditingSkill(sk);
    setShowSkillEditor(true);
  }, []);

  const handleSaveSkill = useCallback(async ({ id, name, content }) => {
    if (id) {
      const updated = await api.updateTemplate(id, { name, content });
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, ...updated } : t));
    } else {
      const created = await api.createTemplate({ name, content });
      setTemplates(prev => [...prev, created]);
      setSelectedTemplateId(created.id);
    }
  }, []);

  const handleImportSkills = useCallback(async (skillsArr) => {
    const results = await api.importSkills(skillsArr);
    setTemplates(prev => [...prev, ...results]);
  }, []);

  const handleStartAutoclicker = useCallback(async (config) => {
    try {
      await api.startAutoclicker(config);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleStopAutoclicker = useCallback(async () => {
    try {
      await api.stopAutoclicker();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleUpdateNotificationSettings = useCallback(async (updates) => {
    try {
      const updated = await api.updateNotificationSettings(null, updates);
      setNotificationSettings(updated);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleTestNotification = useCallback(async () => {
    try {
      await api.testNotification();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [showToast]);

  const handleRequestNotificationPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
  }, []);

  const handleSelectProject = useCallback((id) => {
    setSelectedProjectId(id);
    setActiveTab('board');
  }, [setSelectedProjectId]);

  const handleClearTestResult = useCallback((id) => {
    setTestStatusMap((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  const selectedTaskProject = useMemo(
    () => selectedTask ? projects.find((p) => p.id === selectedTask.projectId) : null,
    [selectedTask, projects]
  );

  const hasPreview = selectedProject?.url;

  if (authState === null) return null;
  if (authState === 'login') {
    return <LoginScreen onSuccess={() => setAuthState('ok')} />;
  }

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
          onShowToast={showToast}
          tasks={tasks}
          theme={theme}
          onToggleTheme={toggleTheme}
          authRequired={authRequired}
          onLogout={async () => { await api.logout(); setAuthState('login'); }}
        />
      </ErrorBoundary>
      <main className="main">
        <GenerateBar
          generatingMap={generatingMap}
          onGenerate={handleGenerate}
          selectedProjectId={selectedProjectId}
          projects={projects}
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          onCreateTemplate={handleCreateTemplate}
          onDeleteTemplate={handleDeleteTemplate}
          onOpenSkillEditor={handleOpenSkillEditor}
          models={models}
        />
        {hasActiveAgents && (
          <button className="btn btn-stop-all" onClick={handleStopAll}>
            Stop All
          </button>
        )}
        <FilterBar
          filters={filters}
          onFiltersChange={setFilters}
          models={models}
        />
        <div className="tab-bar">
          <button
            className={`tab ${activeTab === 'board' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('board')}
          >
            Board
          </button>
          <button
            className={`tab ${activeTab === 'dashboard' ? 'tab-active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          {hasPreview && (
            <button
              className={`tab ${activeTab === 'preview' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              Preview
            </button>
          )}
        </div>
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
              onMergePR={handleMergePR}
              models={models}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              filterActive={filterActive}
              onPlanAll={handlePlanAll}
              onExecuteAll={handleExecuteAll}
              focusedTaskId={focusedTaskId}
              onReorderTasks={handleReorderTasks}
              onMoveTask={handleMoveTask}
              onRetry={handleRetry}
              blockedTaskIds={blockedTaskIds}
              onRankProposals={handleRankProposals}
              rankingMap={rankingMap}
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
                disabled={bulkInFlight}
              />
            )}
          </ErrorBoundary>
        ) : activeTab === 'dashboard' ? (
          <ErrorBoundary name="Dashboard">
            <AnalyticsDashboard
              selectedProjectId={selectedProjectId}
              projects={projects}
              models={models}
              tasks={tasks}
            />
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
          onMergePR={handleMergePR}
          models={models}
          streamingLog={streamingLog}
          logStreamVersion={logStreamVersion}
          replayResult={selectedTask ? replayResults[selectedTask.id] : null}
          allTasks={tasks}
          blockedTaskIds={blockedTaskIds}
        />
      </ErrorBoundary>
      <button className="activity-bell" onClick={toggleActivityFeed} title="Activity feed">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="activity-bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>
      <ActivityFeed
        isOpen={activityFeedOpen}
        activities={activities}
        lastSeenTimestamp={lastSeenTimestamp}
        onClose={() => setActivityFeedOpen(false)}
        onSelectTask={(task) => { setSelectedTask(task); setActivityFeedOpen(false); }}
        onExecute={handleExecute}
        onPlan={handlePlan}
        onRetry={handleRetry}
        onMarkAllRead={markAllRead}
        onDismissEntry={dismissEntry}
        tasks={tasks}
      />
      <PlatesSpinning
        tasks={tasks}
        generatingMap={generatingMap}
        setupMap={setupMap}
        rankingMap={rankingMap}
        models={models}
        agentCensus={agentCensus}
      />
      {commandPaletteOpen && (
        <CommandPalette
          projects={projects}
          tasks={filteredTasks}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          onSelectTask={setSelectedTask}
          onPlan={handlePlan}
          onExecute={handleExecute}
          onDismiss={handleDismiss}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
      {showSkillEditor && (
        <SkillEditor
          skill={editingSkill}
          skills={templates}
          project={projects.find(p => p.id === selectedProjectId)}
          onSave={handleSaveSkill}
          onClose={() => setShowSkillEditor(false)}
          onDelete={handleDeleteTemplate}
          onImport={handleImportSkills}
        />
      )}
      <Toast message={statusMessage} type={statusType} onDismiss={() => setStatusMessage(null)} />
    </div>
  );
}
