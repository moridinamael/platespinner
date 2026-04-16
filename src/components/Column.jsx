import { memo, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import Card from './Card.jsx';

function Column({ title, tasks, projectMap, execStartTimes, planStartTimes, onExecute, onPlan, onDismiss, onAbort, onDequeue, onSelectTask, onMerge, onCreatePR, onMergePR, models, selectedIds, onToggleSelect, filterActive, columnKey, onPlanAll, onExecuteAll, focusedTaskId, onRetry, blockedTaskIds, onRankProposals, rankingMap }) {
  const isProposedColumn = columnKey === 'proposed';
  const executingTasks = tasks.filter(t => t.status !== 'queued');
  const queuedTasks = tasks.filter(t => t.status === 'queued')
    .sort((a, b) => (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0));
  const hasQueuedSection = queuedTasks.length > 0;

  const { setNodeRef: setDroppableRef } = useDroppable({ id: columnKey });
  const sortableIds = useMemo(() => tasks.map(t => t.id), [tasks]);

  const proposedGroups = useMemo(() => {
    if (!isProposedColumn) return [];
    const byProject = new Map();
    for (const t of executingTasks) {
      if (t.status !== 'proposed') continue;
      if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
      byProject.get(t.projectId).push(t);
    }
    return [...byProject.entries()].map(([projectId, projTasks]) => ({
      projectId,
      project: projectMap[projectId],
      tasks: projTasks,
    }));
  }, [isProposedColumn, executingTasks, projectMap]);

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
        {columnKey === 'failed' && tasks.length > 0 && (
          <button className="btn btn-execute btn-column-action" onClick={() => tasks.forEach(t => onRetry(t.id))} title="Retry all failed tasks">
            Retry All
          </button>
        )}
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="column-body" ref={setDroppableRef}>
          {isProposedColumn ? (
            proposedGroups.map(({ projectId, project, tasks: projTasks }) => {
              const projectName = project?.name || 'Unknown project';
              const canRank = projTasks.length >= 2;
              const isRanking = !!rankingMap[projectId];
              return (
                <div key={projectId} className="project-group">
                  <div className="project-subheader">
                    <span className="project-subheader-label">{projectName}</span>
                    <span className="project-subheader-count">{projTasks.length}</span>
                    {canRank && (
                      <button
                        className="btn btn-column-action project-subheader-rank"
                        onClick={() => onRankProposals(projectId)}
                        disabled={isRanking}
                        title="Rank proposed tasks by priority for this project"
                      >
                        {isRanking ? (
                          <><span className="spinner spinner-sm" /> Ranking...</>
                        ) : (
                          'Rank'
                        )}
                      </button>
                    )}
                  </div>
                  {projTasks.map((task) => (
                    <Card
                      key={task.id}
                      task={task}
                      project={project}
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
                      onMergePR={onMergePR}
                      models={models}
                      isSelected={selectedIds?.has(task.id)}
                      onToggleSelect={onToggleSelect}
                      isFocused={task.id === focusedTaskId}
                      onRetry={onRetry}
                      isBlocked={blockedTaskIds?.has(task.id)}
                    />
                  ))}
                </div>
              );
            })
          ) : (
            executingTasks.map((task) => (
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
                onMergePR={onMergePR}
                models={models}
                isSelected={selectedIds?.has(task.id)}
                onToggleSelect={onToggleSelect}
                isFocused={task.id === focusedTaskId}
                onRetry={onRetry}
                isBlocked={blockedTaskIds?.has(task.id)}
              />
            ))
          )}
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
              onMergePR={onMergePR}
              queuePosition={index + 1}
              models={models}
              isSelected={selectedIds?.has(task.id)}
              onToggleSelect={onToggleSelect}
              isFocused={task.id === focusedTaskId}
              onRetry={onRetry}
              isBlocked={blockedTaskIds?.has(task.id)}
            />
          ))}
          {tasks.length === 0 && (
            <div className="column-empty">
              <svg className="column-empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <line x1="9" y1="12" x2="15" y2="12" />
                <line x1="9" y1="16" x2="12" y2="16" />
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
