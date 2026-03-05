import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { EFFORT_COLORS, formatCost } from '../utils.js';
import Sparkline from './Sparkline.jsx';

export default function Sidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onAddProject,
  onRemoveProject,
  onUpdateProjectUrl,
  setupMap,
  setupResultMap,
  onClearSetupResult,
  onCreateFixTask,
  testStatusMap,
  railwayStatusMap,
  onClearTestResult,
  autoclickerStatus,
  onStartAutoclicker,
  onStopAutoclicker,
  notificationSettings,
  onUpdateNotificationSettings,
  onTestNotification,
  onRequestNotificationPermission,
  tasks,
}) {
  const [path, setPath] = useState('');
  const [pushing, setPushing] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [gitInfo, setGitInfo] = useState(null);
  const [urlInput, setUrlInput] = useState('');

  const [testInfo, setTestInfo] = useState(null);
  const [testCmdInput, setTestCmdInput] = useState('');
  const [creatingFix, setCreatingFix] = useState(false);
  const [fixCreated, setFixCreated] = useState(false);
  const [railwayInput, setRailwayInput] = useState('');
  const [budgetInput, setBudgetInput] = useState('');
  const [confirmingProjectId, setConfirmingProjectId] = useState(null);
  const confirmTimerRef = useRef(null);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [webhookUrlLocal, setWebhookUrlLocal] = useState('');

  // Autoclicker local state
  const [acEnabled, setAcEnabled] = useState(false);
  const [acMaxParallel, setAcMaxParallel] = useState(3);
  const [acStandoff, setAcStandoff] = useState(0);
  const [acSelectedProjects, setAcSelectedProjects] = useState(new Set());

  const testStatus = testStatusMap[selectedProjectId];
  const testing = !!testStatus?.running;
  const testResult = testStatus?.result || null;
  const railwayStatus = railwayStatusMap[selectedProjectId];
  const checkingRailway = railwayStatus?.status === 'checking';
  const railwayResult = railwayStatus && railwayStatus.status !== 'unknown' && railwayStatus.status !== 'checking'
    ? { healthy: railwayStatus.status === 'healthy', message: railwayStatus.message, checkedAt: railwayStatus.checkedAt }
    : null;
  const settingUp = !!setupMap[selectedProjectId];
  const setupResult = setupResultMap[selectedProjectId] || null;
  const setupProgress = setupMap[selectedProjectId] || null;

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // Sync URL input, test command, and fetch git status + test info when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setGitInfo(null);
      setUrlInput('');
      setTestInfo(null);
      setTestCmdInput('');
      setRailwayInput('');
      return;
    }
    setUrlInput(selectedProject?.url || '');
    setTestCmdInput(selectedProject?.testCommand || '');
    setRailwayInput(selectedProject?.railwayProject || '');
    setBudgetInput(selectedProject?.budgetLimitUsd != null ? String(selectedProject.budgetLimitUsd) : '');
    api.getGitStatus(selectedProjectId).then(setGitInfo).catch(() => setGitInfo(null));
    api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => setTestInfo(null));
  }, [selectedProjectId, selectedProject?.url, selectedProject?.testCommand, selectedProject?.railwayProject]);

  // When setup completes, refresh test info and git status
  useEffect(() => {
    if (!setupResult || !selectedProjectId) return;
    api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => {});
    api.getGitStatus(selectedProjectId).then(setGitInfo).catch(() => {});
  }, [setupResult, selectedProjectId]);

  useEffect(() => {
    if (autoclickerStatus) {
      setAcEnabled(autoclickerStatus.running);
      if (autoclickerStatus.enabledProjects) {
        setAcSelectedProjects(new Set(autoclickerStatus.enabledProjects));
      }
      if (autoclickerStatus.maxParallel) setAcMaxParallel(autoclickerStatus.maxParallel);
    }
  }, [autoclickerStatus]);

  useEffect(() => {
    if (notificationSettings) {
      setWebhookUrlLocal(notificationSettings.webhookUrl === '****' ? '****' : (notificationSettings.webhookUrl || ''));
    }
  }, [notificationSettings?.webhookUrl]);

  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!path.trim()) return;
    onAddProject({ path: path.trim() });
    setPath('');
  };

  const handlePush = async (projectId) => {
    setPushing(projectId);
    setPushResult(null);
    try {
      const result = await api.pushProject(projectId);
      setPushResult({ success: true, output: result.output });
      api.getGitStatus(projectId).then(setGitInfo).catch(() => {});
    } catch (err) {
      setPushResult({ success: false, output: err.message });
    } finally {
      setPushing(null);
      setTimeout(() => setPushResult(null), 5000);
    }
  };

  const handleTestCmdSave = async () => {
    if (!selectedProjectId) return;
    const trimmed = testCmdInput.trim();
    if (trimmed === (selectedProject?.testCommand || '')) return;
    try {
      await api.updateProject(selectedProjectId, { testCommand: trimmed });
      api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => {});
    } catch { /* ignore */ }
  };

  const handleRunTests = async () => {
    if (!selectedProjectId) return;
    setFixCreated(false);
    try {
      await api.runTests(selectedProjectId);
      // Status updates come via WebSocket (test-started / test-completed)
    } catch {
      // Only if the HTTP request itself fails (network error, 404, etc.)
    }
  };

  const handleSetupTests = async () => {
    if (!selectedProjectId) return;
    try {
      await api.setupTests(selectedProjectId);
    } catch { /* fire-and-forget, errors come via WS */ }
  };

  const handleRailwaySave = async () => {
    if (!selectedProjectId) return;
    const trimmed = railwayInput.trim();
    if (trimmed === (selectedProject?.railwayProject || '')) return;
    try {
      await api.updateProject(selectedProjectId, { railwayProject: trimmed });
    } catch { /* ignore */ }
  };

  const handleCheckRailway = async () => {
    if (!selectedProjectId) return;
    try {
      await api.checkRailway(selectedProjectId);
    } catch { /* errors handled via WS broadcast */ }
  };

  // Cost dashboard data
  const projectTasks = selectedProjectId && tasks ? tasks.filter(t => t.projectId === selectedProjectId) : [];
  const totalProjectCost = projectTasks.reduce((sum, t) => sum + (t.costUsd || 0), 0);
  const budgetLimit = selectedProject?.budgetLimitUsd;
  const budgetPercent = budgetLimit ? Math.min((totalProjectCost / budgetLimit) * 100, 100) : null;
  const costByEffort = { small: 0, medium: 0, large: 0 };
  for (const t of projectTasks) {
    if (t.effort in costByEffort) costByEffort[t.effort] += (t.costUsd || 0);
  }
  const costTimeline = projectTasks
    .filter(t => t.costUsd > 0)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(t => ({ timestamp: t.createdAt, cost: t.costUsd }));

  const handleBudgetSave = async () => {
    if (!selectedProjectId) return;
    const val = budgetInput.trim();
    const numVal = val === '' ? null : parseFloat(val);
    if (val !== '' && (isNaN(numVal) || numVal < 0)) return;
    const current = selectedProject?.budgetLimitUsd;
    if (numVal === current || (numVal === null && current === null)) return;
    try {
      await api.updateProject(selectedProjectId, { budgetLimitUsd: numVal });
    } catch { /* ignore */ }
  };

  const canRunTests = testInfo && testInfo.source !== 'none';

  function getProjectStatusColor(projectId) {
    const ts = testStatusMap[projectId];
    const rs = railwayStatusMap[projectId];
    const isRunning = !!ts?.running || rs?.status === 'checking';
    if (isRunning) return 'yellow';
    if (ts?.result && !ts.result.passed) return 'red';
    if (rs?.status === 'failed') return 'red';
    if (ts?.result?.passed && rs?.status === 'healthy') return 'green';
    if (ts?.result?.passed) return 'green';
    if (rs?.status === 'healthy') return 'green';
    return 'gray';
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return null;
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  return (
    <aside className="sidebar">
      <h1 className="sidebar-title">Kanban Agents</h1>

      <button
        className="btn btn-sm btn-notif-toggle"
        onClick={() => setShowNotifSettings((prev) => !prev)}
        title="Notification settings"
      >
        Notifications {notificationSettings?.enabled ? '(on)' : '(off)'}
      </button>

      {showNotifSettings && notificationSettings && (
        <div className="sidebar-notifications">
          <label className="setting-field setting-field-row">
            <input
              type="checkbox"
              className="setting-checkbox"
              checked={!!notificationSettings.enabled}
              onChange={(e) => onUpdateNotificationSettings({ enabled: e.target.checked })}
            />
            <span className="setting-label">Enable notifications</span>
          </label>

          {notificationSettings.enabled && (
            <>
              <label className="setting-field setting-field-row">
                <input
                  type="checkbox"
                  className="setting-checkbox"
                  checked={!!notificationSettings.browserNotifications}
                  onChange={(e) => {
                    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
                      onRequestNotificationPermission();
                    }
                    onUpdateNotificationSettings({ browserNotifications: e.target.checked });
                  }}
                />
                <span className="setting-label">Browser notifications</span>
              </label>
              {'Notification' in window && notificationSettings.browserNotifications && Notification.permission !== 'granted' && (
                <button className="btn btn-sm" onClick={onRequestNotificationPermission}>
                  Grant Permission
                </button>
              )}

              <label className="setting-field setting-field-row">
                <input
                  type="checkbox"
                  className="setting-checkbox"
                  checked={!!notificationSettings.desktopNotifications}
                  onChange={(e) => onUpdateNotificationSettings({ desktopNotifications: e.target.checked })}
                />
                <span className="setting-label">Desktop notifications</span>
              </label>

              <label className="setting-field">
                <span className="setting-label">Webhook URL</span>
                <input
                  type="text"
                  className="input input-sm"
                  placeholder="https://hooks.slack.com/..."
                  value={webhookUrlLocal}
                  onChange={(e) => setWebhookUrlLocal(e.target.value)}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val !== (notificationSettings.webhookUrl || '')) {
                      onUpdateNotificationSettings({ webhookUrl: val });
                    }
                  }}
                />
              </label>

              {notificationSettings.webhookUrl && (
                <label className="setting-field">
                  <span className="setting-label">Webhook Secret (optional)</span>
                  <input
                    type="password"
                    className="input input-sm"
                    placeholder="HMAC signing key"
                    defaultValue=""
                    onBlur={(e) => {
                      if (e.target.value) {
                        onUpdateNotificationSettings({ webhookSecret: e.target.value });
                      }
                    }}
                  />
                </label>
              )}

              <div className="notif-events-section">
                <span className="setting-label">Events</span>
                {[
                  ['taskCompleted', 'Task completed'],
                  ['taskFailed', 'Task failed'],
                  ['allTasksDone', 'All tasks done'],
                  ['testFailure', 'Test failure'],
                ].map(([key, label]) => (
                  <label key={key} className="setting-field setting-field-row">
                    <input
                      type="checkbox"
                      className="setting-checkbox"
                      checked={!!notificationSettings.events?.[key]}
                      onChange={(e) =>
                        onUpdateNotificationSettings({
                          events: { [key]: e.target.checked },
                        })
                      }
                    />
                    <span className="setting-label">{label}</span>
                  </label>
                ))}
              </div>

              <button className="btn btn-sm" onClick={onTestNotification}>
                Send Test Notification
              </button>
            </>
          )}
        </div>
      )}

      <form className="add-project-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Project path..."
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="input"
        />
        <button type="submit" className="btn btn-primary">
          Add Project
        </button>
      </form>

      <nav className="project-list">
        <button
          className={`project-item ${selectedProjectId === null ? 'active' : ''}`}
          onClick={() => onSelectProject(null)}
        >
          All Projects
        </button>
        {projects.map((p) => {
          const statusColor = getProjectStatusColor(p.id);
          const ts = testStatusMap[p.id];
          const rs = railwayStatusMap[p.id];
          const rr = rs && rs.status !== 'unknown' && rs.status !== 'checking'
            ? { healthy: rs.status === 'healthy', message: rs.message, checkedAt: rs.checkedAt }
            : null;
          const isTestRunning = !!ts?.running;
          const isRailwayChecking = rs?.status === 'checking';
          return (
          <div key={p.id} className={`project-item ${selectedProjectId === p.id ? 'active' : ''}`}>
            <button className="project-btn" onClick={() => onSelectProject(p.id)}>
              <span className="status-dot-wrapper">
                <span className={`status-dot status-dot-${statusColor}`} />
                <span className="status-tooltip">
                  <span className="status-tooltip-row">
                    <span className="status-tooltip-label">Tests:</span>
                    <span className={`status-tooltip-value ${
                      isTestRunning ? 'status-running' :
                      ts?.result ? (ts.result.passed ? 'status-ok' : 'status-err') : ''
                    }`}>
                      {isTestRunning ? 'running...' :
                       ts?.result ? ts.result.summary : 'not run'}
                    </span>
                  </span>
                  {(p.railwayProject || rr) && (
                    <span className="status-tooltip-row">
                      <span className="status-tooltip-label">Railway:</span>
                      <span className={`status-tooltip-value ${
                        isRailwayChecking ? 'status-running' :
                        rr ? (rr.healthy ? 'status-ok' : 'status-err') : ''
                      }`}>
                        {isRailwayChecking ? 'checking...' :
                         rr ? rr.message : 'not checked'}
                      </span>
                    </span>
                  )}
                  {(ts?.result?.checkedAt || rr?.checkedAt) && (
                    <span className="status-tooltip-time">
                      {formatTimeAgo(Math.max(ts?.result?.checkedAt || 0, rr?.checkedAt || 0))}
                    </span>
                  )}
                </span>
              </span>
              <span className="project-name">{p.name}</span>
            </button>
            <button
              className={`project-remove${confirmingProjectId === p.id ? ' confirming' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (confirmingProjectId === p.id) {
                  clearTimeout(confirmTimerRef.current);
                  setConfirmingProjectId(null);
                  onRemoveProject(p.id);
                } else {
                  setConfirmingProjectId(p.id);
                  clearTimeout(confirmTimerRef.current);
                  confirmTimerRef.current = setTimeout(() => setConfirmingProjectId(null), 3000);
                }
              }}
              title={confirmingProjectId === p.id ? 'Click again to confirm' : 'Remove project'}
            >
              {confirmingProjectId === p.id ? 'Sure?' : '\u00d7'}
            </button>
          </div>
          );
        })}
      </nav>

      {/* Autoclicker Mode Panel */}
      <div className="sidebar-autoclicker">
        <label className="setting-field setting-field-row">
          <input
            type="checkbox"
            className="setting-checkbox"
            checked={acEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                setAcEnabled(true);
              } else {
                setAcEnabled(false);
                if (autoclickerStatus?.running) onStopAutoclicker();
              }
            }}
          />
          <span className="setting-label">Autoclicker Mode</span>
        </label>

        {acEnabled && (
          <div className="autoclicker-controls">
            <div className="autoclicker-projects">
              <span className="setting-label">Enabled Projects</span>
              {projects.map(p => (
                <label key={p.id} className="autoclicker-project-check">
                  <input
                    type="checkbox"
                    checked={acSelectedProjects.has(p.id)}
                    onChange={(e) => {
                      setAcSelectedProjects(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        return next;
                      });
                    }}
                  />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>

            <label className="setting-field">
              <span className="setting-label">Max Parallel Processes</span>
              <input
                type="number"
                className="input input-sm"
                min="1" max="10"
                value={acMaxParallel}
                onChange={(e) => setAcMaxParallel(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
              />
            </label>

            <label className="setting-field">
              <span className="setting-label">Spawn Standoff (seconds)</span>
              <input
                type="number"
                className="input input-sm"
                min="0" max="300"
                value={acStandoff}
                onChange={(e) => setAcStandoff(Math.max(0, parseInt(e.target.value) || 0))}
              />
            </label>

            <button
              className={`btn ${autoclickerStatus?.running ? 'btn-danger' : 'btn-primary'}`}
              disabled={acSelectedProjects.size === 0 && !autoclickerStatus?.running}
              onClick={() => {
                if (autoclickerStatus?.running) {
                  onStopAutoclicker();
                } else {
                  onStartAutoclicker({
                    enabledProjectIds: [...acSelectedProjects],
                    maxParallel: acMaxParallel,
                    standoffSeconds: acStandoff,
                  });
                }
              }}
            >
              {autoclickerStatus?.running ? 'Stop Autoclicker' : 'Start Autoclicker'}
            </button>

            {autoclickerStatus?.running && (
              <div className="autoclicker-status">
                <div className="autoclicker-status-row">
                  <span>Active: {autoclickerStatus.activeProcessCount} / {autoclickerStatus.maxParallel}</span>
                </div>
                {autoclickerStatus.projectStatuses && Object.entries(autoclickerStatus.projectStatuses).map(([pid, status]) => {
                  const proj = projects.find(p => p.id === pid);
                  return (
                    <div key={pid} className="autoclicker-project-status">
                      <span className="project-name-sm">{proj?.name || pid.slice(0, 8)}</span>
                      <span className={`cycle-status cycle-status-${status}`}>{status}</span>
                    </div>
                  );
                })}
                {autoclickerStatus.auditLog?.length > 0 && (
                  <details className="autoclicker-log">
                    <summary>Recent Actions ({autoclickerStatus.auditLog.length})</summary>
                    <div className="autoclicker-log-entries">
                      {autoclickerStatus.auditLog.slice(-10).reverse().map((entry, i) => (
                        <div key={i} className="audit-entry">
                          <span className="audit-action">{entry.action}</span>
                          <span className="audit-reasoning">{entry.reasoning}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedProjectId && (
        <div className="sidebar-project-settings">
          <label className="setting-field">
            <span className="setting-label">Preview URL</span>
            <input
              type="text"
              className="input input-sm"
              placeholder="http://localhost:3000"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onBlur={() => onUpdateProjectUrl(selectedProjectId, urlInput)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </label>
          <label className="setting-field">
            <span className="setting-label">Test Command</span>
            <input
              type="text"
              className="input input-sm"
              placeholder="npm test"
              value={testCmdInput}
              onChange={(e) => setTestCmdInput(e.target.value)}
              onBlur={handleTestCmdSave}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </label>
          <label className="setting-field">
            <span className="setting-label">Railway Project</span>
            <input
              type="text"
              className="input input-sm"
              placeholder="my-railway-project"
              value={railwayInput}
              onChange={(e) => setRailwayInput(e.target.value)}
              onBlur={handleRailwaySave}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </label>
          <label className="setting-field setting-field-row">
            <input
              type="checkbox"
              className="setting-checkbox"
              checked={!!selectedProject?.autoTestOnCommit}
              onChange={async (e) => {
                try {
                  await api.updateProject(selectedProjectId, { autoTestOnCommit: e.target.checked });
                } catch { /* ignore */ }
              }}
            />
            <span className="setting-label">Auto-test after commit</span>
          </label>
          <label className="setting-field">
            <span className="setting-label">Branch Strategy</span>
            <select
              className="select input-sm"
              value={selectedProject?.branchStrategy || 'direct'}
              onChange={async (e) => {
                try {
                  await api.updateProject(selectedProjectId, { branchStrategy: e.target.value });
                } catch { /* ignore */ }
              }}
            >
              <option value="direct">Direct (commit to current branch)</option>
              <option value="per-task">Per-task (feature branch per task)</option>
              <option value="per-batch">Per-batch (branch per generation)</option>
            </select>
          </label>
        </div>
      )}

      {selectedProjectId && (
        <div className="sidebar-tests">
          {testInfo && testInfo.description && (
            <div className="test-description">{testInfo.description}</div>
          )}
          {testInfo && testInfo.source === 'none' && (
            <div className="test-description test-none">No test framework detected</div>
          )}
          <div className="test-btn-row">
            <button
              className="btn btn-test"
              onClick={handleRunTests}
              disabled={testing || !canRunTests}
            >
              {testing ? (
                <><span className="spinner spinner-sm" /> Running...</>
              ) : (
                'Run Tests'
              )}
            </button>
            <button
              className="btn btn-setup-tests"
              onClick={handleSetupTests}
              disabled={settingUp}
              title="Spawn an agent to set up or fix tests for this project"
            >
              {settingUp ? (
                <><span className="spinner spinner-sm" /> Setting up...</>
              ) : (
                'Setup Tests'
              )}
            </button>
          </div>
          {settingUp && setupProgress && (
            <div className="setup-progress">
              Agent working... ({Math.round(setupProgress.bytesReceived / 1024)}KB output)
            </div>
          )}
          {setupResult && (
            <div className={`test-result ${setupResult.success ? 'test-pass' : 'test-fail'}`}>
              <div className="test-summary">
                {setupResult.success ? '\u2713' : '\u2717'} {setupResult.summary}
                <button
                  className="setup-result-dismiss"
                  onClick={() => onClearSetupResult(selectedProjectId)}
                  title="Dismiss"
                >&times;</button>
              </div>
              {setupResult.commitHash && (
                <div className="setup-commit">Commit: {setupResult.commitHash.slice(0, 7)}</div>
              )}
            </div>
          )}
          {testResult && (
            <div className={`test-result ${testResult.passed ? 'test-pass' : 'test-fail'}`}>
              <div className="test-summary">
                {testResult.passed ? '\u2713' : '\u2717'} {testResult.summary}
              </div>
              {testResult.output && (
                <details className="test-output">
                  <summary>Show output</summary>
                  <pre>{testResult.output}</pre>
                </details>
              )}
              {!testResult.passed && (
                <button
                  className="btn btn-fix-tests"
                  disabled={creatingFix || fixCreated}
                  onClick={async () => {
                    setCreatingFix(true);
                    try {
                      await onCreateFixTask(selectedProjectId, testResult.summary, testResult.output);
                      setFixCreated(true);
                    } finally {
                      setCreatingFix(false);
                    }
                  }}
                >
                  {creatingFix ? (
                    <><span className="spinner spinner-sm" /> Creating...</>
                  ) : fixCreated ? (
                    '\u2713 Task Created'
                  ) : (
                    'Create Fix Task'
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {selectedProjectId && selectedProject?.railwayProject && (
        <div className="sidebar-railway">
          <button
            className="btn btn-railway"
            onClick={handleCheckRailway}
            disabled={checkingRailway}
          >
            {checkingRailway ? (
              <><span className="spinner spinner-sm" /> Checking...</>
            ) : (
              'Check Railway'
            )}
          </button>
          {railwayResult && (
            <div className={`railway-result ${railwayResult.healthy ? 'railway-ok' : 'railway-fail'}`}>
              {railwayResult.healthy ? '\u2713' : '\u2717'} {railwayResult.message}
            </div>
          )}
        </div>
      )}

      {selectedProjectId && (totalProjectCost > 0 || budgetLimit) && (
        <div className="sidebar-costs">
          <div className="costs-header">
            <span className="costs-total-label">Total Spend</span>
            <span className="costs-total-value">{formatCost(totalProjectCost)}</span>
          </div>
          {budgetLimit && (
            <div className="budget-bar-container">
              <div className="budget-bar">
                <div
                  className={`budget-bar-fill ${budgetPercent >= 90 ? 'budget-danger' : budgetPercent >= 70 ? 'budget-warn' : ''}`}
                  style={{ width: `${budgetPercent}%` }}
                />
              </div>
              <span className="budget-label">
                {formatCost(totalProjectCost)} / {formatCost(budgetLimit)}
              </span>
            </div>
          )}
          <div className="costs-by-effort">
            {['small', 'medium', 'large'].map(effort => (
              costByEffort[effort] > 0 && (
                <div key={effort} className="cost-effort-row">
                  <span className="effort-dot" style={{ backgroundColor: EFFORT_COLORS[effort] }} />
                  <span className="cost-effort-label">{effort}</span>
                  <span className="cost-effort-value">{formatCost(costByEffort[effort])}</span>
                </div>
              )
            ))}
          </div>
          {costTimeline.length >= 2 && (
            <Sparkline data={costTimeline} />
          )}
          <label className="setting-field">
            <span className="setting-label">Budget Limit ($)</span>
            <input
              type="text"
              className="input input-sm"
              placeholder="No limit"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              onBlur={handleBudgetSave}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            />
          </label>
        </div>
      )}

      {selectedProjectId && gitInfo && (
        <div className="sidebar-git">
          {gitInfo.commitsAhead > 0 && (
            <div className="git-ahead">
              {gitInfo.commitsAhead} unpushed commit{gitInfo.commitsAhead !== 1 ? 's' : ''}
            </div>
          )}
          {gitInfo.commitsAhead === 0 && (
            <div className="git-synced">Up to date with remote</div>
          )}
          <button
            className="btn btn-push"
            onClick={() => handlePush(selectedProjectId)}
            disabled={pushing || gitInfo.commitsAhead === 0}
          >
            {pushing === selectedProjectId ? (
              <><span className="spinner spinner-sm" /> Pushing...</>
            ) : (
              `Git Push`
            )}
          </button>
          {pushResult && (
            <div className={`push-result ${pushResult.success ? 'push-ok' : 'push-err'}`}>
              {pushResult.output}
            </div>
          )}
          {gitInfo.recentCommits.length > 0 && (
            <div className="recent-commits">
              {gitInfo.recentCommits.map((c, i) => (
                <div key={i} className="commit-line">{c}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
