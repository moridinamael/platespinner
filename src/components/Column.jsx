import Card from './Card.jsx';

export default function Column({ title, tasks, projectMap, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onSelectTask, models }) {
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
            onSelect={onSelectTask}
            models={models}
          />
        ))}
        {tasks.length === 0 && <div className="column-empty">No tasks</div>}
      </div>
    </div>
  );
}
