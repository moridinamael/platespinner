import { memo, useMemo } from 'react';

function DependencyEditor({ task, allTasks, dependencies, onChange }) {
  // Filter to same-project tasks, excluding self
  const availableTasks = useMemo(() => {
    return allTasks.filter(t =>
      t.projectId === task.projectId &&
      t.id !== task.id &&
      !dependencies.includes(t.id)
    );
  }, [allTasks, task.id, task.projectId, dependencies]);

  const selectedTasks = useMemo(() => {
    return dependencies
      .map(id => allTasks.find(t => t.id === id))
      .filter(Boolean);
  }, [dependencies, allTasks]);

  const addDependency = (depId) => {
    if (!depId || dependencies.includes(depId)) return;
    onChange([...dependencies, depId]);
  };

  const removeDependency = (depId) => {
    onChange(dependencies.filter(id => id !== depId));
  };

  return (
    <div className="dependency-editor">
      {selectedTasks.length > 0 && (
        <div className="dependency-chips">
          {selectedTasks.map(t => (
            <span key={t.id} className="dependency-chip">
              <span className={`dependency-status-dot status-${t.status}`} />
              <span className="dependency-chip-title">{t.title}</span>
              <button
                className="dependency-chip-remove"
                onClick={() => removeDependency(t.id)}
                title="Remove dependency"
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      {availableTasks.length > 0 && (
        <div className="dependency-add">
          <select
            className="select dependency-select"
            defaultValue=""
            onChange={(e) => {
              addDependency(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="" disabled>Add dependency...</option>
            {availableTasks.map(t => (
              <option key={t.id} value={t.id}>
                [{t.status}] {t.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {selectedTasks.length === 0 && availableTasks.length === 0 && (
        <p className="text-muted">No other tasks in this project</p>
      )}
    </div>
  );
}

export default memo(DependencyEditor);
