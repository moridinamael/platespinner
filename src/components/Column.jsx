import Card from './Card.jsx';

export default function Column({ title, tasks, projectMap, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelectTask, models, selectedIds, onToggleSelect, filterActive }) {
  const executingTasks = tasks.filter(t => t.status !== 'queued');
  const queuedTasks = tasks.filter(t => t.status === 'queued')
    .sort((a, b) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0));
  const hasQueuedSection = queuedTasks.length > 0;

  return (
    <div className="column">
      <div className="column-header">
        <h2>{title}</h2>
        <span className={`column-count${filterActive ? ' column-count-filtered' : ''}`}>{tasks.length}</span>
      </div>
      <div className="column-body">
        {executingTasks.map((task) => (
          <Card
            key={task.id}
            task={task}
            project={projectMap[task.projectId]}
            execStartTime={execStartTimes[task.id]}
            planStartTime={planStartTimes?.[task.id]}
            onExecute={onExecute}
            onPlan={onPlan}
            onDismiss={onDismiss}
            onAbort={onAbort}
            onDequeue={onDequeue}
            onSelect={onSelectTask}
            models={models}
            isSelected={selectedIds?.has(task.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
        {hasQueuedSection && (
          <div className="queue-divider">
            <span className="queue-divider-label">Queued ({queuedTasks.length})</span>
          </div>
        )}
        {queuedTasks.map((task, index) => (
          <Card
            key={task.id}
            task={task}
            project={projectMap[task.projectId]}
            execStartTime={execStartTimes[task.id]}
            planStartTime={planStartTimes?.[task.id]}
            onExecute={onExecute}
            onPlan={onPlan}
            onDismiss={onDismiss}
            onAbort={onAbort}
            onDequeue={onDequeue}
            onSelect={onSelectTask}
            queuePosition={index + 1}
            models={models}
            isSelected={selectedIds?.has(task.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
        {tasks.length === 0 && (
          <div className="column-empty">
            <svg className="column-empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
            <span className="column-empty-text">No tasks yet</span>
          </div>
        )}
      </div>
    </div>
  );
}
