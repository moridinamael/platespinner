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
}) {
  const [path, setPath] = useState('');
  const [pushing, setPushing] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [gitInfo, setGitInfo] = useState(null);
  const [urlInput, setUrlInput] = useState('');

  // Test state — per-project maps so state survives navigation
  const [testingMap, setTestingMap] = useState({});   // { [projectId]: true }
  const [testResultMap, setTestResultMap] = useState({}); // { [projectId]: result }
  const [testInfo, setTestInfo] = useState(null);
  const [testCmdInput, setTestCmdInput] = useState('');

  const testing = !!testingMap[selectedProjectId];
  const testResult = testResultMap[selectedProjectId] || null;
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
      return;
    }
    setUrlInput(selectedProject?.url || '');
    setTestCmdInput(selectedProject?.testCommand || '');
    api.getGitStatus(selectedProjectId).then(setGitInfo).catch(() => setGitInfo(null));
    api.getTestInfo(selectedProjectId).then(setTestInfo).catch(() => setTestInfo(null));
  }, [selectedProjectId, selectedProject?.url, selectedProject?.testCommand]);

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
    const projectId = selectedProjectId;
    setTestingMap((prev) => ({ ...prev, [projectId]: true }));
    setTestResultMap((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
    try {
      const result = await api.runTests(projectId);
      setTestResultMap((prev) => ({ ...prev, [projectId]: result }));
      setTimeout(() => setTestResultMap((prev) => { const next = { ...prev }; delete next[projectId]; return next; }), 10000);
    } catch (err) {
      const result = { passed: false, summary: err.message, output: '', description: null };
      setTestResultMap((prev) => ({ ...prev, [projectId]: result }));
      setTimeout(() => setTestResultMap((prev) => { const next = { ...prev }; delete next[projectId]; return next; }), 10000);
    } finally {
      setTestingMap((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
    }
  };

  const handleSetupTests = async () => {
    if (!selectedProjectId) return;
    try {
      await api.setupTests(selectedProjectId);
    } catch { /* fire-and-forget, errors come via WS */ }
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
        {projects.map((p) => (
          <div key={p.id} className={`project-item ${selectedProjectId === p.id ? 'active' : ''}`}>
            <button className="project-btn" onClick={() => onSelectProject(p.id)}>
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
        ))}
      </nav>

      {selectedProjectId && (
        <div className="sidebar-project-settings">
          <div className="url-field">
            <input
              type="text"
              className="input input-sm"
              placeholder="Preview URL (e.g. http://localhost:3000)"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onBlur={() => onUpdateProjectUrl(selectedProjectId, urlInput)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </div>
          <div className="test-cmd-field">
            <input
              type="text"
              className="input input-sm"
              placeholder="Test command (e.g. npm test)"
              value={testCmdInput}
              onChange={(e) => setTestCmdInput(e.target.value)}
              onBlur={handleTestCmdSave}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </div>
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
