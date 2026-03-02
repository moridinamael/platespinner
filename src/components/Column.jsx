import Card from './Card.jsx';

export default function Column({ title, tasks, projectMap, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onSelectTask, models }) {
  return (
    <div className="column">
      <div className="column-header">
        <h2>{title}</h2>
        <span className="column-count">{tasks.length}</span>
      </div>
      <div className="column-body">
        {tasks.map((task) => (
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
            onSelect={onSelectTask}
            models={models}
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
