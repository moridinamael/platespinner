import { memo, useRef, useEffect } from 'react';
import { formatCost } from '../utils.js';

const EVENT_ICONS = {
  generation: { color: 'var(--purple)', label: 'G' },
  planning:   { color: 'var(--accent)', label: 'P' },
  execution:  { color: 'var(--green)', label: 'E' },
  ranking:    { color: 'var(--yellow)', label: 'R' },
  test:       { color: 'var(--orange)', label: 'T' },
  'setup-tests': { color: 'var(--orange)', label: 'S' },
};

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getActionForEntry(entry, task) {
  if (!task) return null;
  const status = entry.status;
  if (status === 'failed' || status === 'aborted') return { label: 'Retry', action: 'retry' };
  switch (entry.eventType) {
    case 'planning': return { label: 'Execute', action: 'execute' };
    case 'execution': return { label: 'Review Diff', action: 'review' };
    case 'generation': return { label: 'Plan', action: 'plan' };
    default: return null;
  }
}

function ActivityFeed({
  isOpen,
  activities,
  lastSeenTimestamp,
  onClose,
  onSelectTask,
  onExecute,
  onPlan,
  onRetry,
  onMarkAllRead,
  onDismissEntry,
  tasks,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [activities.length, isOpen]);

  if (!isOpen) return null;

  const handleAction = (entry, task) => {
    const act = getActionForEntry(entry, task);
    if (!act) return;
    switch (act.action) {
      case 'execute': onExecute(task.id); break;
      case 'plan': onPlan(task.id); break;
      case 'retry': onRetry(task.id); break;
      case 'review': onSelectTask(task); break;
    }
  };

  return (
    <div className="activity-feed">
      <div className="activity-feed-header">
        <h3 className="activity-feed-title">Activity</h3>
        {activities.length > 0 && (
          <button className="btn btn-sm activity-feed-clear" onClick={onMarkAllRead}>
            Mark all read
          </button>
        )}
        <button className="activity-feed-close" onClick={onClose}>&times;</button>
      </div>
      <div className="activity-feed-list" ref={listRef}>
        {activities.length === 0 && (
          <div className="activity-feed-empty">No recent activity</div>
        )}
        {activities.map(entry => {
          const icon = EVENT_ICONS[entry.eventType] || { color: 'var(--text-dim)', label: '?' };
          const isFailed = entry.status === 'failed' || entry.status === 'aborted';
          const task = entry.taskId ? tasks.find(t => t.id === entry.taskId) : null;
          const suggested = getActionForEntry(entry, task);
          const isUnread = entry.timestamp > lastSeenTimestamp;

          return (
            <div key={entry.id} className={`activity-feed-item ${isUnread ? 'unread' : ''}`}>
              <span
                className="activity-feed-icon"
                style={{ background: isFailed ? 'var(--red)' : icon.color }}
              >
                {icon.label}
              </span>
              <div className="activity-feed-content">
                {task ? (
                  <button
                    className="activity-feed-task-title"
                    onClick={() => onSelectTask(task)}
                  >
                    {entry.taskTitle || task.title}
                  </button>
                ) : (
                  <span className="activity-feed-task-title activity-feed-task-title--static">
                    {entry.taskTitle || entry.summary || entry.eventType}
                  </span>
                )}
                <div className="activity-feed-meta">
                  {entry.projectName && (
                    <span className="project-badge">{entry.projectName}</span>
                  )}
                  <span className="activity-feed-time">{formatTimeAgo(entry.timestamp)}</span>
                  <span className={`activity-feed-status activity-feed-status-${isFailed ? 'failed' : 'success'}`}>
                    {entry.status}
                  </span>
                  {entry.costUsd > 0 && (
                    <span className="cost-badge">{formatCost(entry.costUsd)}</span>
                  )}
                </div>
                {entry.suggestedAction && (
                  <div className="activity-feed-suggested">{entry.suggestedAction}</div>
                )}
              </div>
              <div className="activity-feed-actions">
                {suggested && task && (
                  <button
                    className={`btn btn-sm ${suggested.action === 'execute' ? 'btn-execute' : suggested.action === 'retry' ? 'btn-plan' : 'btn-primary'}`}
                    onClick={(e) => { e.stopPropagation(); handleAction(entry, task); }}
                  >
                    {suggested.label}
                  </button>
                )}
                <button
                  className="activity-feed-dismiss"
                  onClick={() => onDismissEntry(entry.id)}
                  title="Dismiss"
                >
                  &times;
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(ActivityFeed);
