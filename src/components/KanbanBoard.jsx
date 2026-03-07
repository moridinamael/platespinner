import { useState, memo, useMemo, useCallback } from 'react';
import { DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import Column from './Column.jsx';

const COLUMNS = [
  { key: 'proposed', title: 'Proposed', statuses: ['proposed'] },
  { key: 'plan', title: 'Plan', statuses: ['planning', 'planned'] },
  { key: 'executing', title: 'Executing', statuses: ['queued', 'executing'] },
  { key: 'done', title: 'Done', statuses: ['done'] },
  { key: 'failed', title: 'Failed', statuses: ['failed'] },
];

function KanbanBoard({ tasks, projects, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelectTask, onMerge, onCreatePR, models, selectedIds, onToggleSelect, filterActive, onPlanAll, onExecuteAll, focusedTaskId, onReorderTasks, onMoveTask, onRetry, blockedTaskIds }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [activeId, setActiveId] = useState(null);
  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;

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
    // Sort proposed and plan columns by sortOrder
    map['proposed'].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    map['plan'].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    return map;
  }, [tasks]);

  const findColumn = useCallback((taskId) => {
    for (const col of COLUMNS) {
      if (tasksByColumn[col.key].some(t => t.id === taskId)) return col.key;
    }
    return null;
  }, [tasksByColumn]);

  const handleDragStart = useCallback((event) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback((event) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeTaskId = active.id;
    const overId = over.id;

    const sourceCol = findColumn(activeTaskId);
    const isColumnDrop = COLUMNS.some(c => c.key === overId);
    const targetCol = isColumnDrop ? overId : findColumn(overId);

    if (!sourceCol || !targetCol) return;

    if (sourceCol === targetCol) {
      // Reorder within column
      const colTasks = tasksByColumn[sourceCol];
      const oldIndex = colTasks.findIndex(t => t.id === activeTaskId);
      const newIndex = colTasks.findIndex(t => t.id === overId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const reordered = [...colTasks];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      onReorderTasks(reordered.map(t => t.id));
    } else {
      // Cross-column move
      onMoveTask(activeTaskId, sourceCol, targetCol);
    }
  }, [findColumn, tasksByColumn, onReorderTasks, onMoveTask]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
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
            focusedTaskId={focusedTaskId}
            onRetry={onRetry}
            blockedTaskIds={blockedTaskIds}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className={`card card-drag-overlay card-${activeTask.status}`}>
            <div className="card-header"><span className="card-title">{activeTask.title}</span></div>
            <div className="card-body"><p className="card-description">{activeTask.description}</p></div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default memo(KanbanBoard);
