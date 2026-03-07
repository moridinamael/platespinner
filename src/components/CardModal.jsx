import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { useConfirm } from '../hooks/useConfirm.js';
import { api } from '../api.js';
import { getModelLabel, getModelProvider, formatCost, formatTokens, formatLogSize, escapeHtml, sanitizeAnsiHtml } from '../utils.js';
import DiffViewer from './DiffViewer.jsx';
import DependencyEditor from './DependencyEditor.jsx';
import DependencyGraph from './DependencyGraph.jsx';
import AnsiToHtml from 'ansi-to-html';

const ansiConverter = new AnsiToHtml({ fg: '#959ab0', bg: 'transparent', newline: true, escapeXML: true });

function formatEventType(type) {
  switch (type) {
    case 'prompt_sent': return 'Prompt Sent';
    case 'response_received': return 'Response Received';
    case 'parsed_output': return 'Output Parsed';
    case 'error': return 'Error';
    default: return type;
  }
}

function CardModal({ task, project, onClose, onExecute, onPlan, onDismiss, onAbort, onDequeue, onUpdateTask, onMerge, onCreatePR, onMergePR, models, streamingLog, logStreamVersion, replayResult, allTasks, blockedTaskIds }) {
  if (!task) return null;

  const isProposed = task.status === 'proposed';
  const isPlanning = task.status === 'planning';
  const isPlanned = task.status === 'planned';
  const isQueued = task.status === 'queued';
  const isExecuting = task.status === 'executing';
  const isDone = task.status === 'done';
  const isActive = isExecuting || isPlanning;

  // Default model: same as generating model, or first available
  const defaultModelId = task.generatedBy || (models?.[0]?.id) || 'claude-opus-4-6';
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const [confirmingDismiss, armDismiss, resetDismiss] = useConfirm();
  const [mergeStrategy, setMergeStrategy] = useState('merge');

  // Tab state — always available now (details, changes for done, logs for all)
  const [activeTab, setActiveTab] = useState('details');
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(null);
  const [revertStatus, setRevertStatus] = useState(null);

  // Log viewer state
  const [logContent, setLogContent] = useState('');
  const [logMeta, setLogMeta] = useState([]);
  const [selectedLogPhase, setSelectedLogPhase] = useState(null);
  const [logSearch, setLogSearch] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const logContainerRef = useRef(null);

  // Related tasks state
  const [relatedTasks, setRelatedTasks] = useState(null);
  const [relatedLoading, setRelatedLoading] = useState(false);

  // Timeline/replay state
  const [replayTimeline, setReplayTimeline] = useState(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState(null);
  const [expandedEventId, setExpandedEventId] = useState(null);
  const [replayRunning, setReplayRunning] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftRationale, setDraftRationale] = useState('');
  const [draftEffort, setDraftEffort] = useState('medium');
  const [draftPlan, setDraftPlan] = useState('');
  const [draftDependencies, setDraftDependencies] = useState([]);

  // Reset state on task change
  useEffect(() => {
    resetDismiss();
    setEditing(false);
    setActiveTab('details');
    setDiff(null);
    setDiffError(null);
    setRevertStatus(null);
    setLogContent('');
    setLogMeta([]);
    setSelectedLogPhase(null);
    setLogSearch('');
    setRelatedTasks(null);
    setReplayTimeline(null);
    setReplayError(null);
    setExpandedEventId(null);
    setReplayRunning(false);
  }, [task?.id]);

  // Fetch diff when Changes tab is selected
  useEffect(() => {
    if (activeTab !== 'changes' || !isDone || !task?.id) return;
    if (diff) return;
    setDiffLoading(true);
    setDiffError(null);
    api.getTaskDiff(task.id)
      .then(res => {
        setDiff(res.diff);
        setDiffLoading(false);
      })
      .catch(err => {
        setDiffError(err.message);
        setDiffLoading(false);
      });
  }, [activeTab, task?.id, isDone, diff]);

  // Fetch log metadata when Logs tab is selected
  useEffect(() => {
    if (activeTab !== 'logs' || !task) return;
    api.getTaskLogMeta(task.id).then(setLogMeta).catch(() => setLogMeta([]));
  }, [activeTab, task?.id]);

  // Auto-select latest available phase
  useEffect(() => {
    if (logMeta.length > 0 && !selectedLogPhase) {
      setSelectedLogPhase(logMeta[logMeta.length - 1].phase);
    }
  }, [logMeta, selectedLogPhase]);

  // Fetch log content when phase changes (for completed tasks)
  useEffect(() => {
    if (!selectedLogPhase || !task || activeTab !== 'logs') return;
    if (isActive) return; // For active tasks, use streaming buffer
    setLogLoading(true);
    api.getTaskLog(task.id, selectedLogPhase)
      .then(({ text }) => {
        setLogContent(text);
        setLogLoading(false);
      })
      .catch(() => { setLogContent(''); setLogLoading(false); });
  }, [selectedLogPhase, task?.id, activeTab, isActive]);

  // Fetch replay timeline when Timeline tab is selected
  useEffect(() => {
    if (activeTab !== 'timeline' || !task) return;
    if (replayTimeline) return;
    setReplayLoading(true);
    api.getTaskReplay(task.id)
      .then(data => {
        setReplayTimeline(data.events || []);
        setReplayLoading(false);
      })
      .catch(err => {
        setReplayError(err.message);
        setReplayLoading(false);
      });
  }, [activeTab, task?.id, replayTimeline]);

  // Fetch related tasks when Related tab is selected
  useEffect(() => {
    if (activeTab !== 'related' || !task) return;
    if (relatedTasks) return;
    setRelatedLoading(true);
    api.getSimilarTasks(task.id)
      .then(data => {
        setRelatedTasks(data.similar || []);
        setRelatedLoading(false);
      })
      .catch(() => { setRelatedTasks([]); setRelatedLoading(false); });
  }, [activeTab, task?.id, relatedTasks]);

  // Handle incoming replay result from WebSocket
  useEffect(() => {
    if (replayResult) {
      setReplayRunning(false);
    }
  }, [replayResult]);

  // Compute displayed log content
  const displayedLog = useMemo(() => {
    let raw = isActive ? (streamingLog || logContent) : logContent;

    // Apply search filter (strip ANSI for matching)
    if (logSearch && raw) {
      const searchLower = logSearch.toLowerCase();
      const lines = raw.split('\n');
      const filtered = lines.filter(l =>
        l.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase().includes(searchLower)
      );
      raw = filtered.join('\n');
    }
    return raw;
  }, [logContent, streamingLog, logSearch, isActive, logStreamVersion]);

  // Convert ANSI to HTML
  const renderedLog = useMemo(() => {
    if (!displayedLog) return '<span style="color: var(--text-dim)">No log available</span>';
    // Cap at 500KB for rendering performance
    const text = displayedLog.length > 512000
      ? displayedLog.slice(-512000) + '\n\n... (truncated, showing last 500KB) ...'
      : displayedLog;
    try {
      return sanitizeAnsiHtml(ansiConverter.toHtml(text));
    } catch {
      return escapeHtml(text);
    }
  }, [displayedLog]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (logContainerRef.current && isActive && activeTab === 'logs') {
      const el = logContainerRef.current;
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (isAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [renderedLog, isActive, activeTab]);

  const handleRevert = async () => {
    if (!task?.commitHash || !task?.projectId) return;
    setRevertStatus('reverting');
    try {
      await api.revertTask(task.projectId, task.id);
      setRevertStatus('reverted');
    } catch (err) {
      setRevertStatus('error');
    }
  };

  const enterEditMode = () => {
    setDraftTitle(task.title || '');
    setDraftDescription(task.description || '');
    setDraftRationale(task.rationale || '');
    setDraftEffort(task.effort || 'medium');
    setDraftPlan(task.plan || '');
    setDraftDependencies(task.dependencies || []);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = () => {
    const updates = {
      title: draftTitle,
      description: draftDescription,
      rationale: draftRationale,
      effort: draftEffort,
      dependencies: draftDependencies,
    };
    if (isPlanned && task.plan != null) {
      updates.plan = draftPlan;
    }
    onUpdateTask(task.id, updates);
    setEditing(false);
  };

  // Resolve model labels for display
  const generatedByLabel = getModelLabel(task.generatedBy, models);
  const plannedByLabel = getModelLabel(task.plannedBy, models);
  const executedByLabel = getModelLabel(task.executedBy, models);
  const generatedByProvider = getModelProvider(task.generatedBy, models);
  const plannedByProvider = getModelProvider(task.plannedBy, models);
  const executedByProvider = getModelProvider(task.executedBy, models);

  // Backwards compat for old agentType field
  const legacyLabel = !task.generatedBy && !task.executedBy && task.agentType
    ? task.agentType.charAt(0).toUpperCase() + task.agentType.slice(1)
    : null;

  const isBlocked = blockedTaskIds?.has(task.id);

  // Compute dependents: tasks that depend on this task
  const dependents = useMemo(() => {
    if (!allTasks || !task) return [];
    return allTasks.filter(t => t.dependencies && t.dependencies.includes(task.id));
  }, [allTasks, task]);

  // Show tabs when: done (details/changes/logs), or active (details/logs), or any task has logs
  const showTabs = isDone || isActive || isPlanned || isProposed;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {editing ? (
            <input
              type="text"
              className="input modal-edit-title"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Task title"
            />
          ) : (
            <h2 className="modal-title">{task.title}</h2>
          )}
          <button className="modal-close" onClick={onClose} title="Close (Esc)">&times;</button>
        </div>

        <div className="modal-meta">
          {editing ? (
            <select
              className="select modal-edit-effort"
              value={draftEffort}
              onChange={(e) => setDraftEffort(e.target.value)}
            >
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="large">large</option>
            </select>
          ) : (
            <span className={`effort-badge effort-${task.effort || 'medium'}`}>
              {task.effort}
            </span>
          )}
          {generatedByLabel && (
            <span className={`model-badge model-${generatedByProvider}`} title="Generated by">
              {generatedByLabel}
            </span>
          )}
          {plannedByLabel && (
            <span className={`model-badge model-${plannedByProvider}`} title="Planned by">
              {plannedByLabel}
            </span>
          )}
          {executedByLabel && (
            <span className={`model-badge model-${executedByProvider}`} title="Executed by">
              {executedByLabel}
            </span>
          )}
          {legacyLabel && (
            <span className={`model-badge model-${task.agentType}`}>
              {legacyLabel}
            </span>
          )}
          {project && (
            <span className="project-badge">
              {project.name}
            </span>
          )}
          <span className="modal-status">{task.status}</span>
          {isBlocked && <span className="blocked-badge">Blocked</span>}
          {isDone && task.commitHash && (
            <span className="commit-hash">{task.commitHash.slice(0, 7)}</span>
          )}
          {isDone && task.branch && (
            <span className="branch-badge">{task.branch}</span>
          )}
          {isDone && task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noopener noreferrer" className="pr-link">
              PR #{task.prNumber || ''}
            </a>
          )}
          {isDone && task.prStatus && task.prStatus.ciStatus && task.prStatus.ciStatus !== 'unknown' && (
            <span className={`pr-status-badge pr-ci-${task.prStatus.ciStatus}`}>
              CI: {task.prStatus.ciStatus}
            </span>
          )}
          {isDone && task.prStatus?.reviewDecision && (
            <span className={`pr-status-badge pr-review-${task.prStatus.reviewDecision.toLowerCase()}`}>
              {task.prStatus.reviewDecision}
            </span>
          )}
          {isDone && task.prStatus?.mergeable && task.prStatus.mergeable !== 'UNKNOWN' && (
            <span className={`pr-status-badge pr-mergeable-${task.prStatus.mergeable.toLowerCase()}`}>
              {task.prStatus.mergeable === 'MERGEABLE' ? 'Mergeable' : 'Conflicts'}
            </span>
          )}
          {isDone && task.merged && (
            <span className="pr-merged-badge">Merged</span>
          )}
          {task.costUsd > 0 && (
            <span className="cost-badge">{formatCost(task.costUsd)}</span>
          )}
        </div>

        {showTabs && (
          <div className="modal-tabs">
            <button
              className={`modal-tab${activeTab === 'details' ? ' active' : ''}`}
              onClick={() => setActiveTab('details')}
            >
              Details
            </button>
            {isDone && (
              <button
                className={`modal-tab${activeTab === 'changes' ? ' active' : ''}`}
                onClick={() => setActiveTab('changes')}
              >
                Changes
              </button>
            )}
            <button
              className={`modal-tab${activeTab === 'logs' ? ' active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              Logs
              {isActive && <span className="modal-tab-badge live-badge">LIVE</span>}
            </button>
            <button
              className={`modal-tab${activeTab === 'timeline' ? ' active' : ''}`}
              onClick={() => setActiveTab('timeline')}
            >
              Timeline
            </button>
            <button
              className={`modal-tab${activeTab === 'related' ? ' active' : ''}`}
              onClick={() => setActiveTab('related')}
            >
              Related
              {task.similarTasks?.length > 0 && (
                <span className="modal-tab-badge">{task.similarTasks.length}</span>
              )}
            </button>
          </div>
        )}

        {activeTab === 'details' && (
          <>
            <div className="modal-section">
              <h3>Description</h3>
              {editing ? (
                <textarea
                  className="input modal-edit-textarea"
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  rows={4}
                  placeholder="Task description"
                />
              ) : (
                <p>{task.description}</p>
              )}
            </div>

            {(editing || task.rationale) && (
              <div className="modal-section">
                <h3>Rationale</h3>
                {editing ? (
                  <textarea
                    className="input modal-edit-textarea"
                    value={draftRationale}
                    onChange={(e) => setDraftRationale(e.target.value)}
                    rows={3}
                    placeholder="Why this task matters"
                  />
                ) : (
                  <p>{task.rationale}</p>
                )}
              </div>
            )}

            <div className="modal-section">
              <h3>Dependencies {isBlocked && <span className="blocked-badge">Blocked</span>}</h3>
              {editing ? (
                <DependencyEditor
                  task={task}
                  allTasks={allTasks || []}
                  dependencies={draftDependencies}
                  onChange={setDraftDependencies}
                />
              ) : (
                <>
                  {task.dependencies?.length > 0 ? (
                    <div className="dependency-list">
                      {task.dependencies.map(depId => {
                        const dep = (allTasks || []).find(t => t.id === depId);
                        return dep ? (
                          <div key={depId} className={`dependency-item dependency-${dep.status}`}>
                            <span className={`dependency-status-dot status-${dep.status}`} />
                            <span className="dependency-title">{dep.title}</span>
                            <span className="dependency-status">{dep.status}</span>
                          </div>
                        ) : (
                          <div key={depId} className="dependency-item dependency-missing">
                            <span className="dependency-title">Unknown task ({depId.slice(0,8)})</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-muted">No dependencies</p>
                  )}
                  {dependents.length > 0 && (
                    <div className="dependents-section">
                      <h4>Depended on by</h4>
                      {dependents.map(t => (
                        <div key={t.id} className="dependency-item">
                          <span className={`dependency-status-dot status-${t.status}`} />
                          <span className="dependency-title">{t.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Dependency graph for tasks with deps or dependents */}
            {!editing && ((task.dependencies?.length > 0) || dependents.length > 0) && (
              <div className="modal-section">
                <h3>Dependency Graph</h3>
                <DependencyGraph
                  tasks={allTasks || []}
                  focusTaskId={task.id}
                />
              </div>
            )}

            {(editing && isPlanned) || task.plan ? (
              <div className="modal-section">
                <h3>Implementation Plan</h3>
                {editing && isPlanned ? (
                  <textarea
                    className="input modal-edit-textarea modal-edit-plan"
                    value={draftPlan}
                    onChange={(e) => setDraftPlan(e.target.value)}
                    rows={10}
                  />
                ) : (
                  <pre className="modal-plan">{task.plan}</pre>
                )}
              </div>
            ) : null}

            {isDone && task.agentLog && (
              <div className="modal-section">
                <h3>Agent Log</h3>
                <pre className="modal-log">{task.agentLog}</pre>
              </div>
            )}

            {task.costUsd > 0 && (
              <div className="modal-section modal-cost-section">
                <h3>Cost</h3>
                <div className="cost-summary">
                  <span className="cost-total">{formatCost(task.costUsd)}</span>
                  {task.tokenUsage && (
                    <div className="cost-breakdown">
                      {task.tokenUsage.generation && (
                        <div className="cost-phase">
                          <span className="cost-phase-label">Generation</span>
                          <span className="cost-phase-tokens">
                            {formatTokens(task.tokenUsage.generation.input)} in / {formatTokens(task.tokenUsage.generation.output)} out
                          </span>
                        </div>
                      )}
                      {task.tokenUsage.planning && (
                        <div className="cost-phase">
                          <span className="cost-phase-label">Planning</span>
                          <span className="cost-phase-tokens">
                            {formatTokens(task.tokenUsage.planning.input)} in / {formatTokens(task.tokenUsage.planning.output)} out
                          </span>
                        </div>
                      )}
                      {task.tokenUsage.execution && (
                        <div className="cost-phase">
                          <span className="cost-phase-label">Execution</span>
                          <span className="cost-phase-tokens">
                            {formatTokens(task.tokenUsage.execution.input)} in / {formatTokens(task.tokenUsage.execution.output)} out
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {isDone && activeTab === 'changes' && (
          <div className="modal-section">
            {diffLoading && <p className="text-muted">Loading diff...</p>}
            {diffError && <p className="text-error">Error: {diffError}</p>}
            {!diffLoading && !diffError && !diff && <p className="text-muted">No changes recorded for this task.</p>}
            {!diffLoading && diff && (
              <DiffViewer
                diff={diff}
                commitHash={task.commitHash}
                onCopy={() => navigator.clipboard.writeText(diff)}
                onRevert={task.commitHash && !task.reverted && revertStatus !== 'reverted' ? handleRevert : null}
              />
            )}
            {revertStatus === 'reverting' && <p className="text-muted" style={{ marginTop: 8 }}>Reverting...</p>}
            {revertStatus === 'reverted' && <p style={{ marginTop: 8, color: 'var(--green)', fontSize: 13 }}>Commit reverted successfully.</p>}
            {revertStatus === 'error' && <p className="text-error" style={{ marginTop: 8 }}>Revert failed. There may be conflicts.</p>}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="modal-section modal-logs-section">
            <div className="log-toolbar">
              <div className="log-phase-selector">
                {isActive && (
                  <button
                    className={`log-phase-btn ${!selectedLogPhase || selectedLogPhase === (isPlanning ? 'planning' : 'execution') ? 'active' : ''}`}
                    onClick={() => setSelectedLogPhase(isPlanning ? 'planning' : 'execution')}
                  >
                    {isPlanning ? 'planning' : 'execution'}
                    <span className="log-live-dot" />
                  </button>
                )}
                {logMeta.map(m => (
                  <button
                    key={m.phase}
                    className={`log-phase-btn ${selectedLogPhase === m.phase ? 'active' : ''}`}
                    onClick={() => setSelectedLogPhase(m.phase)}
                  >
                    {m.phase}
                    <span className="log-size">{formatLogSize(m.size)}</span>
                  </button>
                ))}
                {!isActive && logMeta.length === 0 && (
                  <span className="text-muted" style={{ fontSize: 12 }}>No logs available</span>
                )}
              </div>
              <input
                type="text"
                className="log-search"
                placeholder="Search logs..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
              />
              <button
                className="btn btn-sm log-copy-btn"
                onClick={() => {
                  const plain = displayedLog || '';
                  navigator.clipboard.writeText(plain);
                }}
              >
                Copy Log
              </button>
            </div>
            <div className="log-viewer" ref={logContainerRef}>
              {logLoading ? (
                <div className="log-loading">Loading...</div>
              ) : (
                <pre
                  className="log-content"
                  dangerouslySetInnerHTML={{ __html: renderedLog }}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="modal-section modal-timeline-section">
            {replayLoading && <p className="text-muted">Loading timeline...</p>}
            {replayError && <p className="text-error">Error: {replayError}</p>}
            {!replayLoading && replayTimeline && replayTimeline.length === 0 && (
              <p className="text-muted">No replay data recorded for this task. Replay data is captured for new agent invocations.</p>
            )}
            {!replayLoading && replayTimeline && replayTimeline.length > 0 && (
              <div className="timeline">
                {replayTimeline.map((event, i) => {
                  const eventKey = event.id || i;
                  const isExpanded = expandedEventId === eventKey;
                  return (
                    <div
                      key={eventKey}
                      className={`timeline-event timeline-event-${event.type}${isExpanded ? ' expanded' : ''}`}
                      onClick={() => setExpandedEventId(isExpanded ? null : eventKey)}
                    >
                      <div className="timeline-event-header">
                        <span className={`timeline-event-icon timeline-icon-${event.type}`}>
                          {event.type === 'prompt_sent' ? '>' :
                           event.type === 'response_received' ? '<' :
                           event.type === 'parsed_output' ? '{}' :
                           event.type === 'error' ? '!' : '?'}
                        </span>
                        <span className="timeline-event-type">{formatEventType(event.type)}</span>
                        <span className="timeline-event-phase">{event.phase}</span>
                        {event.modelId && <span className="timeline-event-model">{event.modelId}</span>}
                        {event.costUsd > 0 && <span className="timeline-event-cost">{formatCost(event.costUsd)}</span>}
                        {event.durationMs && <span className="timeline-event-duration">{(event.durationMs / 1000).toFixed(1)}s</span>}
                        <span className="timeline-event-time">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {isExpanded && (
                        <div className="timeline-event-detail">
                          {event.type === 'prompt_sent' && (
                            <>
                              <pre className="timeline-prompt">{event.prompt}</pre>
                              <button
                                className="btn btn-replay"
                                disabled={replayRunning}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setReplayRunning(true);
                                  api.replayTaskPhase(task.id, event.phase)
                                    .catch(err => {
                                      setReplayRunning(false);
                                    });
                                }}
                              >
                                {replayRunning ? 'Replaying...' : 'Replay This Prompt'}
                              </button>
                            </>
                          )}
                          {event.type === 'response_received' && (
                            <>
                              <div className="timeline-stats">
                                {event.inputTokens != null && <span>Input: {formatTokens(event.inputTokens)}</span>}
                                {event.outputTokens != null && <span>Output: {formatTokens(event.outputTokens)}</span>}
                                {event.numTurns != null && <span>Turns: {event.numTurns}</span>}
                              </div>
                              <pre className="timeline-response">{event.rawResponse}</pre>
                            </>
                          )}
                          {event.type === 'parsed_output' && (
                            <pre className="timeline-parsed">
                              {typeof event.parsedResult === 'string'
                                ? event.parsedResult
                                : JSON.stringify(event.parsedResult, null, 2)}
                            </pre>
                          )}
                          {event.type === 'error' && (
                            <>
                              <p className="timeline-error-msg">{event.error}</p>
                              {event.stack && <pre className="timeline-stack">{event.stack}</pre>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {replayResult && (
                  <div className="timeline-replay-result">
                    <h4>Replay Result</h4>
                    {replayResult.error
                      ? <p className="text-error">{replayResult.error}</p>
                      : <pre className="timeline-response">{replayResult.rawResponse}</pre>
                    }
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'related' && (
          <div className="modal-section modal-related-section">
            {relatedLoading && <p className="text-muted">Finding related tasks...</p>}
            {!relatedLoading && relatedTasks && relatedTasks.length === 0 && (
              <p className="text-muted">No similar tasks found.</p>
            )}
            {!relatedLoading && relatedTasks && relatedTasks.length > 0 && (
              <div className="related-tasks-list">
                {relatedTasks.map(rt => (
                  <div key={rt.taskId} className="related-task-item">
                    <div className="related-task-header">
                      <span className="related-task-title">{rt.title}</span>
                      <span className={`related-task-score score-${rt.score >= 0.7 ? 'high' : rt.score >= 0.4 ? 'medium' : 'low'}`}>
                        {Math.round(rt.score * 100)}% match
                      </span>
                      <span className="related-task-status">{rt.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isProposed && (
          <div className="modal-actions">
            {editing ? (
              <>
                <button className="btn btn-save" onClick={saveEdit}>Save</button>
                <button className="btn btn-cancel" onClick={cancelEdit}>Cancel</button>
              </>
            ) : (
              <>
                <button className="btn btn-edit" onClick={enterEditMode}>Edit</button>
                <select
                  className="select model-select"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                >
                  {(models || []).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button className="btn btn-plan" onClick={() => { onPlan(task.id, selectedModelId); onClose(); }}>
                  Plan <kbd className="shortcut-hint" style={{ opacity: 1 }}>P</kbd>
                </button>
                <button
                  className={`btn btn-dismiss${confirmingDismiss ? ' confirming' : ''}`}
                  onClick={() => {
                    if (confirmingDismiss) { resetDismiss(); onDismiss(task.id); onClose(); }
                    else { armDismiss(); }
                  }}
                >
                  {confirmingDismiss ? 'Are you sure?' : 'Dismiss'}
                </button>
              </>
            )}
          </div>
        )}

        {isPlanned && (
          <div className="modal-actions">
            {editing ? (
              <>
                <button className="btn btn-save" onClick={saveEdit}>Save</button>
                <button className="btn btn-cancel" onClick={cancelEdit}>Cancel</button>
              </>
            ) : (
              <>
                <button className="btn btn-edit" onClick={enterEditMode}>Edit</button>
                <select
                  className="select model-select"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                >
                  {(models || []).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button className="btn btn-execute" onClick={() => { onExecute(task.id, selectedModelId); onClose(); }}>
                  Execute <kbd className="shortcut-hint" style={{ opacity: 1 }}>E</kbd>
                </button>
                <button
                  className={`btn btn-dismiss${confirmingDismiss ? ' confirming' : ''}`}
                  onClick={() => {
                    if (confirmingDismiss) { resetDismiss(); onDismiss(task.id); onClose(); }
                    else { armDismiss(); }
                  }}
                >
                  {confirmingDismiss ? 'Are you sure?' : 'Dismiss'}
                </button>
              </>
            )}
          </div>
        )}

        {isPlanning && (
          <div className="modal-actions">
            <button
              className={`btn btn-dismiss${confirmingDismiss ? ' confirming' : ''}`}
              onClick={() => {
                if (confirmingDismiss) { resetDismiss(); onDismiss(task.id); onClose(); }
                else { armDismiss(); }
              }}
            >
              {confirmingDismiss ? 'Are you sure?' : 'Cancel Planning'}
            </button>
          </div>
        )}

        {isQueued && (
          <div className="modal-actions">
            <span className="modal-status">Queued{task.queuePosition ? ` #${task.queuePosition}` : ''}</span>
            <button className="btn btn-abort" onClick={() => { onDequeue(task.id); onClose(); }}>
              Dequeue
            </button>
            <button
              className={`btn btn-dismiss${confirmingDismiss ? ' confirming' : ''}`}
              onClick={() => {
                if (confirmingDismiss) { resetDismiss(); onDismiss(task.id); onClose(); }
                else { armDismiss(); }
              }}
            >
              {confirmingDismiss ? 'Are you sure?' : 'Dismiss'}
            </button>
          </div>
        )}

        {isExecuting && (
          <div className="modal-actions">
            <button className="btn btn-abort" onClick={() => { onAbort(task.id); onClose(); }}>
              Abort Execution
            </button>
          </div>
        )}

        {isDone && (task.branch || task.prUrl) && (
          <div className="modal-actions">
            {!task.prUrl && task.branch && !task.merged && (
              <>
                <select
                  className="select model-select"
                  value={mergeStrategy}
                  onChange={(e) => setMergeStrategy(e.target.value)}
                >
                  <option value="merge">Merge (--no-ff)</option>
                  <option value="squash">Squash & Merge</option>
                </select>
                <button className="btn btn-merge" onClick={() => { onMerge?.(task.id, mergeStrategy); onClose(); }}>
                  Merge Locally
                </button>
                <button className="btn btn-pr" onClick={() => { onCreatePR?.(task.id); }}>
                  Create PR
                </button>
              </>
            )}
            {task.prUrl && !task.merged && (
              <>
                <select
                  className="select model-select"
                  value={mergeStrategy}
                  onChange={(e) => setMergeStrategy(e.target.value)}
                >
                  <option value="merge">Merge</option>
                  <option value="squash">Squash</option>
                  <option value="rebase">Rebase</option>
                </select>
                <button className="btn btn-merge" onClick={() => { onMergePR?.(task.id, mergeStrategy); onClose(); }}>
                  Merge PR
                </button>
              </>
            )}
            {task.merged && (
              <span className="pr-merged-badge">PR Merged</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(CardModal);
