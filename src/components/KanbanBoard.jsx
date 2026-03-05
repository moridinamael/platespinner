import { memo, useMemo } from 'react';
import Column from './Column.jsx';

const COLUMNS = [
  { key: 'proposed', title: 'Proposed', statuses: ['proposed'] },
  { key: 'plan', title: 'Plan', statuses: ['planning', 'planned'] },
  { key: 'executing', title: 'Executing', statuses: ['queued', 'executing'] },
  { key: 'done', title: 'Done', statuses: ['done'] },
];

function KanbanBoard({ tasks, projects, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelectTask, onMerge, onCreatePR, models, selectedIds, onToggleSelect, filterActive, onPlanAll, onExecuteAll }) {
  const projectMap = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects]
  );

  const tasksByColumn = useMemo(() => {
    const map = {};
    for (const col of COLUMNS) {
      map[col.key] = [];
    }
    for (const t of tasks) {
      for (const col of COLUMNS) {
        if (col.statuses.includes(t.status)) {
          map[col.key].push(t);
          break;
        }
      }
    }
    return map;
  }, [tasks]);

  return (
    <div className="kanban-board">
      {COLUMNS.map((col) => (
        <Column
          key={col.key}
          columnKey={col.key}
          title={col.title}
          tasks={tasksByColumn[col.key]}
          projectMap={projectMap}
          execStartTimes={execStartTimes}
          planStartTimes={planStartTimes}
          onExecute={onExecute}
          onPlan={onPlan}
          onDismiss={onDismiss}
          onAbort={onAbort}
          onDequeue={onDequeue}
          onSelectTask={onSelectTask}
          onMerge={onMerge}
          onCreatePR={onCreatePR}
          models={models}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          filterActive={filterActive}
          onPlanAll={onPlanAll}
          onExecuteAll={onExecuteAll}
        />
      ))}
    </div>
  );
}

export default memo(KanbanBoard);
