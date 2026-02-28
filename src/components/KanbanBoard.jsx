import Column from './Column.jsx';

const COLUMNS = [
  { key: 'proposed', title: 'Proposed', statuses: ['proposed'] },
  { key: 'plan', title: 'Plan', statuses: ['planning', 'planned'] },
  { key: 'executing', title: 'Executing', statuses: ['executing'] },
  { key: 'done', title: 'Done', statuses: ['done'] },
];

export default function KanbanBoard({ tasks, projects, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onSelectTask, models }) {
  const projectMap = Object.fromEntries(projects.map((p) => [p.id, p]));

  return (
    <div className="kanban-board">
      {COLUMNS.map((col) => (
        <Column
          key={col.key}
          title={col.title}
          tasks={tasks.filter((t) => col.statuses.includes(t.status))}
          projectMap={projectMap}
          execStartTimes={execStartTimes}
          planStartTimes={planStartTimes}
          onExecute={onExecute}
          onPlan={onPlan}
          onDismiss={onDismiss}
          onSelectTask={onSelectTask}
          models={models}
        />
      ))}
    </div>
  );
}
