import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useConfirm } from '../hooks/useConfirm.js';
import { useTaskProgress } from '../hooks/useTaskProgress.js';
import { useSharedClock } from '../hooks/useSharedClock.js';
import { formatBytes, resolveTaskModel } from '../utils.js';

const ActivitySpinner = ({ variant }) => (
  <svg className={`activity-spinner activity-spinner-${variant}`} width="16" height="16" viewBox="0 0 16 16">
    <circle className="activity-spinner-track" cx="8" cy="8" r="6" />
    <circle className="activity-spinner-arc" cx="8" cy="8" r="6" />
  </svg>
);

function Card({ task, project, execStartTime, planStartTime, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelect, queuePosition, models, isSelected, onToggleSelect, onMerge, onCreatePR, onMergePR, isFocused, onRetry, isBlocked }) {
  const isProposed = task.status === 'proposed';
  const isPlanning = task.status === 'planning';
  const isPlanned = task.status === 'planned';
  const isQueued = task.status === 'queued';
  const isExecuting = task.status === 'executing';
  const isDone = task.status === 'done';
  const isFailed = task.status === 'failed';

  const isDraggable = isProposed || isPlanned || isFailed;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition: sortTransition,
    isDragging,
  } = useSortable({ id: task.id, disabled: !isDraggable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: sortTransition,
    opacity: isDragging ? 0.4 : 1,
    cursor: isDraggable ? 'grab' : 'pointer',
  };

  const progress = useTaskProgress(task.id);
  const now = useSharedClock(isExecuting || isPlanning);

  const activeStartTime = isPlanning ? planStartTime : execStartTime;
  const elapsed = activeStartTime ? Math.floor((now - activeStartTime) / 1000) : 0;
  const elapsedStr = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  const [confirmingDismiss, armDismiss, resetDismiss] = useConfirm();

  const { label: modelLabel, provider: modelProvider } = resolveTaskModel(task, models);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card card-${task.status}${isSelected ? ' card-selected' : ''}${isFocused ? ' card-focused' : ''}${isDragging ? ' card-dragging' : ''}${isBlocked ? ' card-blocked' : ''}`}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onToggleSelect?.(task.id);
        } else {
          onSelect(task);
        }
      }}
    >
      {/* Selection indicator */}
      <div className="card-select-indicator">
        {isSelected && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
      <div className="card-header">
        <span className="card-title">{task.title}</span>
        {isQueued && queuePosition && (
          <span className="queue-position-badge">#{queuePosition} in queue</span>
        )}
        {isBlocked && (
          <span className="blocked-badge">Blocked</span>
        )}
        {(isProposed || isPlanned || isPlanning || isQueued || isFailed) && (
          <button
            className={`card-dismiss${confirmingDismiss ? ' confirming' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (confirmingDismiss) {
                resetDismiss();
                onDismiss(task.id);
              } else {
                armDismiss();
              }
            }}
            title={confirmingDismiss ? 'Click again to confirm' : (isPlanning ? 'Cancel' : 'Dismiss')}
          >
            {confirmingDismiss ? 'Sure?' : '\u00d7'}
          </button>
        )}
      </div>

      <div className="card-body">
        <p className="card-description">{task.description}</p>

        {task.rationale && <p className="card-rationale">{task.rationale}</p>}

        {isPlanned && task.plan && (
          <div className="card-plan-preview" onClick={(e) => e.stopPropagation()}>
            {task.plan.slice(0, 150)}...
          </div>
        )}
      </div>

      <div className="card-footer">
        <span className={`effort-badge effort-${task.effort || 'medium'}`}>
          {task.effort}
        </span>

        {modelLabel && (
          <span className={`model-badge model-${modelProvider}`}>
            {modelLabel}
          </span>
        )}

        {task.rankingRank != null && (
          <span className="ranking-badge-wrapper">
            <span className="ranking-badge">
              #{task.rankingRank}
            </span>
            {task.rankingReason && (
              <span className="ranking-tooltip">
                {task.rankingScore != null && (
                  <span className="ranking-tooltip-score">Score: {task.rankingScore}/10</span>
                )}
                <span className="ranking-tooltip-reason">{task.rankingReason}</span>
              </span>
            )}
          </span>
        )}

        {task.similarTasks?.length > 0 && (
          <span className="duplicate-badge" title={`${task.similarTasks.length} potential duplicate(s)`}>
            ~{task.similarTasks.length}
          </span>
        )}

        {project && (
          <span className="project-badge">
            {project.name}
          </span>
        )}

        {isProposed && (
          <button
            className="btn btn-sm btn-plan"
            onClick={(e) => { e.stopPropagation(); onPlan(task.id); }}
            disabled={isBlocked}
            title={isBlocked ? 'Blocked by dependencies' : undefined}
          >
            Plan<span className="shortcut-hint">P</span>
          </button>
        )}

        {isPlanning && (
          <span className="executing-status">
            <ActivitySpinner variant="planning" />
            <span className="progress-info">
              {elapsedStr}{progress?.bytesReceived > 0 ? ` · ${formatBytes(progress.bytesReceived)}` : ''}
            </span>
          </span>
        )}

        {isPlanned && (
          <button
            className="btn btn-sm btn-execute"
            onClick={(e) => { e.stopPropagation(); onExecute(task.id); }}
            disabled={isBlocked}
            title={isBlocked ? 'Blocked by dependencies' : undefined}
          >
            Execute<span className="shortcut-hint">E</span>
          </button>
        )}

        {isQueued && (
          <span className="executing-status">
            <span className="queue-badge">Queued{task.queuePosition ? ` #${task.queuePosition}` : ''}</span>
            <button
              className="btn btn-sm btn-abort"
              onClick={(e) => { e.stopPropagation(); onDequeue(task.id); }}
              title="Remove from queue"
            >
              Dequeue
            </button>
          </span>
        )}

        {isExecuting && (
          <span className="executing-status">
            <ActivitySpinner variant="executing" />
            <span className="progress-info">
              {elapsedStr}{progress?.bytesReceived > 0 ? ` · ${formatBytes(progress.bytesReceived)}` : ''}
            </span>
            <button
              className="btn btn-sm btn-abort"
              onClick={(e) => { e.stopPropagation(); onAbort(task.id); }}
              title="Abort execution"
            >
              Abort
            </button>
          </span>
        )}

        {isDone && task.commitHash && (
          <span className="commit-hash" title={task.commitHash}>
            {task.commitHash.slice(0, 7)}
          </span>
        )}
        {isDone && task.branch && (
          <span className="branch-badge" title={task.branch}>
            {task.branch.length > 30 ? task.branch.slice(0, 27) + '...' : task.branch}
          </span>
        )}

        {isFailed && (
          <span className="executing-status">
            <span className="failed-badge">Failed{task.failureCount > 1 ? ` (x${task.failureCount})` : ''}</span>
            <button
              className="btn btn-sm btn-execute"
              onClick={(e) => { e.stopPropagation(); onRetry(task.id); }}
              title="Retry with new planning pass"
            >
              Retry
            </button>
          </span>
        )}
      </div>

      {isDone && (task.branch || task.prUrl) && (
        <div className="card-done-actions" onClick={(e) => e.stopPropagation()}>
          {!task.merged && task.branch && !task.prUrl && (
            <>
              <button className="btn btn-sm btn-merge" onClick={(e) => { e.stopPropagation(); onMerge?.(task.id); }}>
                Merge
              </button>
              <button className="btn btn-sm btn-pr" onClick={(e) => { e.stopPropagation(); onCreatePR?.(task.id); }}>
                Create PR
              </button>
            </>
          )}
          {task.prUrl && (
            <>
              <a href={task.prUrl} target="_blank" rel="noopener noreferrer" className="pr-link" onClick={(e) => e.stopPropagation()}>
                PR #{task.prNumber || ''}
              </a>
              {task.prStatus && task.prStatus.ciStatus && task.prStatus.ciStatus !== 'unknown' && (
                <span className={`pr-status-badge pr-ci-${task.prStatus.ciStatus}`}>
                  {task.prStatus.ciStatus === 'passed' ? 'CI \u2713' :
                   task.prStatus.ciStatus === 'failed' ? 'CI \u2717' :
                   task.prStatus.ciStatus === 'pending' ? 'CI ...' : ''}
                </span>
              )}
              {task.prStatus?.reviewDecision && (
                <span className={`pr-status-badge pr-review-${task.prStatus.reviewDecision.toLowerCase()}`}>
                  {task.prStatus.reviewDecision === 'APPROVED' ? 'Approved' :
                   task.prStatus.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes' :
                   'Review needed'}
                </span>
              )}
              {!task.merged && (
                <button className="btn btn-sm btn-merge" onClick={(e) => { e.stopPropagation(); onMergePR?.(task.id); }}>
                  Merge PR
                </button>
              )}
              {task.merged && (
                <span className="pr-merged-badge">Merged</span>
              )}
            </>
          )}
        </div>
      )}

      {isExecuting && (progress?.gitSummary || progress?.gitUntracked?.length > 0) && (
        <div className="card-git" onClick={(e) => e.stopPropagation()}>
          {progress?.gitSummary && <div className="git-summary">{progress.gitSummary}</div>}
          {progress?.gitFiles?.length > 0 && (
            <div className="git-files">
              {progress.gitFiles.map((f, i) => <div key={i} className="git-file">{f}</div>)}
            </div>
          )}
          {progress?.gitUntracked?.length > 0 && (
            <div className="git-files git-untracked">
              {progress.gitUntracked.map((f, i) => <div key={i} className="git-file">+ {f}</div>)}
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

      {isFailed && task.lastTestOutput && (
        <details className="card-log" onClick={(e) => e.stopPropagation()}>
          <summary>Test failure output</summary>
          <pre>{task.lastTestOutput.slice(0, 5000)}</pre>
        </details>
      )}

      {isFailed && task.agentLog && (
        <details className="card-log" onClick={(e) => e.stopPropagation()}>
          <summary>Agent log</summary>
          <pre>{task.agentLog}</pre>
        </details>
      )}
    </div>
  );
}

export default memo(Card);
