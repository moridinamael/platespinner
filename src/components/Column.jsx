import { memo, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import Card from './Card.jsx';

function Column({ title, tasks, projectMap, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelectTask, onMerge, onCreatePR, models, selectedIds, onToggleSelect, filterActive, columnKey, onPlanAll, onExecuteAll, focusedTaskId }) {
  const executingTasks = tasks.filter(t => t.status !== 'queued');
  const queuedTasks = tasks.filter(t => t.status === 'queued')
    .sort((a, b) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0));
  const hasQueuedSection = queuedTasks.length > 0;

  const { setNodeRef: setDroppableRef } = useDroppable({ id: columnKey });
  const sortableIds = useMemo(() => tasks.map(t => t.id), [tasks]);

  return (
    <div className="column">
      <div className="column-header">
        <h2>{title}</h2>
        <span className={`column-count${filterActive ? ' column-count-filtered' : ''}`}>{tasks.length}</span>
        {columnKey === 'proposed' && tasks.some(t => t.status === 'proposed') && (
          <button className="btn btn-plan btn-column-action" onClick={onPlanAll} title="Plan all proposed tasks">
            Plan All
          </button>
        )}
        {columnKey === 'plan' && tasks.some(t => t.status === 'planned') && (
          <button className="btn btn-execute btn-column-action" onClick={onExecuteAll} title="Execute all planned tasks">
            Execute All
          </button>
        )}
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="column-body" ref={setDroppableRef}>
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
              onMerge={onMerge}
              onCreatePR={onCreatePR}
              models={models}
              isSelected={selectedIds?.has(task.id)}
              onToggleSelect={onToggleSelect}
              isFocused={task.id === focusedTaskId}
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
              onMerge={onMerge}
              onCreatePR={onCreatePR}
              queuePosition={index + 1}
              models={models}
              isSelected={selectedIds?.has(task.id)}
              onToggleSelect={onToggleSelect}
              isFocused={task.id === focusedTaskId}
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
      </SortableContext>
    </div>
  );
}

export default memo(Column);
