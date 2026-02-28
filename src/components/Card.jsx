import { useState, useEffect } from 'react';

const EFFORT_COLORS = {
  small: '#4ade80',
  medium: '#facc15',
  large: '#f87171',
};

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getModelLabel(task, models) {
  // Show the most relevant model: executedBy for done tasks, plannedBy for planned, generatedBy for proposed
  const modelId = task.status === 'done' && task.executedBy
    ? task.executedBy
    : (task.status === 'planned' || task.status === 'planning') && task.plannedBy
      ? task.plannedBy
      : task.generatedBy;

  if (modelId && models?.length) {
    const found = models.find((m) => m.id === modelId);
    if (found) return found.label;
    return modelId; // fallback to raw id
  }

  // Backwards compat: fall back to agentType for old tasks
  if (task.agentType) {
    return task.agentType.charAt(0).toUpperCase() + task.agentType.slice(1);
  }

  return null;
}

function getModelProvider(task, models) {
  const modelId = task.status === 'done' && task.executedBy
    ? task.executedBy
    : (task.status === 'planned' || task.status === 'planning') && task.plannedBy
      ? task.plannedBy
      : task.generatedBy;

  if (modelId && models?.length) {
    const found = models.find((m) => m.id === modelId);
    if (found) return found.provider;
  }

  // Backwards compat
  if (task.agentType) return task.agentType;
  return 'claude';
}

export default function Card({ task, project, execStartTime, planStartTime, onExecute, onPlan, onDismiss, onSelect, models }) {
  const isProposed = task.status === 'proposed';
  const isPlanning = task.status === 'planning';
  const isPlanned = task.status === 'planned';
  const isExecuting = task.status === 'executing';
  const isDone = task.status === 'done';

  // Elapsed timer driven by parent-provided start time (survives unmount/remount)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isExecuting && !isPlanning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isExecuting, isPlanning]);

  const activeStartTime = isPlanning ? planStartTime : execStartTime;
  const elapsed = activeStartTime ? Math.floor((now - activeStartTime) / 1000) : 0;
  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const modelLabel = getModelLabel(task, models);
  const modelProvider = getModelProvider(task, models);

  return (
    <div className={`card card-${task.status}`} onClick={() => onSelect(task)} style={{ cursor: 'pointer' }}>
      <div className="card-header">
        <span className="card-title">{task.title}</span>
        {isProposed && (
          <button className="card-dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(task.id); }} title="Dismiss">
            &times;
          </button>
        )}
      </div>

      <p className="card-description">{task.description}</p>

      {task.rationale && <p className="card-rationale">{task.rationale}</p>}

      {isPlanned && task.plan && (
        <div className="card-plan-preview" onClick={(e) => e.stopPropagation()}>
          {task.plan.slice(0, 150)}...
        </div>
      )}

      <div className="card-footer">
        <span
          className="effort-badge"
          style={{ backgroundColor: EFFORT_COLORS[task.effort] || EFFORT_COLORS.medium }}
        >
          {task.effort}
        </span>

        {modelLabel && (
          <span className={`model-badge model-${modelProvider}`}>
            {modelLabel}
          </span>
        )}

        {project && (
          <span className="project-badge">
            {project.name}
          </span>
        )}

        {isProposed && (
          <button className="btn btn-sm btn-plan" onClick={(e) => { e.stopPropagation(); onPlan(task.id); }}>
            Plan
          </button>
        )}

        {isPlanning && (
          <span className="executing-status">
            <span className="spinner" />
            <span className="progress-info">
              {elapsedStr}{task.progress > 0 ? ` · ${formatBytes(task.progress)}` : ''}
            </span>
          </span>
        )}

        {isPlanned && (
          <button className="btn btn-sm btn-execute" onClick={(e) => { e.stopPropagation(); onExecute(task.id); }}>
            Execute
          </button>
        )}

        {isExecuting && (
          <span className="executing-status">
            <span className="spinner" />
            <span className="progress-info">
              {elapsedStr}{task.progress > 0 ? ` · ${formatBytes(task.progress)}` : ''}
            </span>
          </span>
        )}

        {isDone && task.commitHash && (
          <span className="commit-hash" title={task.commitHash}>
            {task.commitHash.slice(0, 7)}
          </span>
        )}
      </div>

      {isExecuting && (task.gitSummary || task.gitUntracked?.length > 0) && (
        <div className="card-git" onClick={(e) => e.stopPropagation()}>
          {task.gitSummary && <div className="git-summary">{task.gitSummary}</div>}
          {task.gitFiles?.length > 0 && (
            <div className="git-files">
              {task.gitFiles.map((f, i) => <div key={i} className="git-file">{f}</div>)}
            </div>
          )}
          {task.gitUntracked?.length > 0 && (
            <div className="git-files git-untracked">
              {task.gitUntracked.map((f, i) => <div key={i} className="git-file">+ {f}</div>)}
            </div>
          )}
        </div>
      )}

      {isDone && task.agentLog && (
        <details className="card-log" onClick={(e) => e.stopPropagation()}>
          <summary>Agent log</summary>
          <pre>{task.agentLog}</pre>
        </details>
      )}
    </div>
  );
}
