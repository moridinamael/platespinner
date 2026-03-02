import { useState, useEffect } from 'react';
import { api } from '../api.js';

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
  onClearTestResult,
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
  const [checkingRailway, setCheckingRailway] = useState(false);
  const [railwayResult, setRailwayResult] = useState(null);

  const testStatus = testStatusMap[selectedProjectId];
  const testing = !!testStatus?.running;
  const testResult = testStatus?.result || null;
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
    setRailwayResult(null);
    api.getGitStatus(selectedProjectId).then(setGitInfo).catch(() => setGitInfo(null));
    api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => setTestInfo(null));
  }, [selectedProjectId, selectedProject?.url, selectedProject?.testCommand, selectedProject?.railwayProject]);

  // When setup completes, refresh test info and git status
  useEffect(() => {
    if (!setupResult || !selectedProjectId) return;
    api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => {});
    api.getGitStatus(selectedProjectId).then(setGitInfo).catch(() => {});
  }, [setupResult, selectedProjectId]);

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
    setCheckingRailway(true);
    setRailwayResult(null);
    try {
      const result = await api.checkRailway(selectedProjectId);
      setRailwayResult(result);
    } catch (err) {
      setRailwayResult({ healthy: false, message: err.message });
    } finally {
      setCheckingRailway(false);
    }
  };

  const canRunTests = testInfo && testInfo.source !== 'none';

  return (
    <aside className="sidebar">
      <h1 className="sidebar-title">Kanban Agents</h1>

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
          const ts = testStatusMap[p.id];
          const dotClass = ts?.running
            ? 'test-dot test-dot-running'
            : ts?.result
              ? ts.result.passed ? 'test-dot test-dot-pass' : 'test-dot test-dot-fail'
              : '';
          return (
          <div key={p.id} className={`project-item ${selectedProjectId === p.id ? 'active' : ''}`}>
            <button className="project-btn" onClick={() => onSelectProject(p.id)}>
              {dotClass && <span className={dotClass} />}
              <span className="project-name">{p.name}</span>
            </button>
            <button
              className="project-remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveProject(p.id);
              }}
              title="Remove project"
            >
              &times;
            </button>
          </div>
          );
        })}
      </nav>

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
