export const EFFORT_COLORS = {
  small: '#4ade80',
  medium: '#facc15',
  large: '#f87171',
};

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function getModelLabel(modelId, models) {
  if (!modelId) return null;
  if (models?.length) {
    const found = models.find((m) => m.id === modelId);
    if (found) return found.label;
    return modelId;
  }
  return modelId;
}

export function getModelProvider(modelId, models) {
  if (!modelId || !models?.length) return 'claude';
  const found = models.find((m) => m.id === modelId);
  return found ? found.provider : 'claude';
}

// Resolve the most relevant model ID from a task based on its status
export function resolveTaskModelId(task) {
  return task.status === 'done' && task.executedBy
    ? task.executedBy
    : (task.status === 'planned' || task.status === 'planning') && task.plannedBy
      ? task.plannedBy
      : task.generatedBy;
}

export function getModelLabelForTask(task, models) {
  const modelId = resolveTaskModelId(task);

  if (modelId && models?.length) {
    const found = models.find((m) => m.id === modelId);
    if (found) return found.label;
    return modelId;
  }

  // Backwards compat: fall back to agentType for old tasks
  if (task.agentType) {
    return task.agentType.charAt(0).toUpperCase() + task.agentType.slice(1);
  }

  return null;
}

export function getModelProviderForTask(task, models) {
  const modelId = resolveTaskModelId(task);

  if (modelId && models?.length) {
    const found = models.find((m) => m.id === modelId);
    if (found) return found.provider;
  }

  // Backwards compat
  if (task.agentType) return task.agentType;
  return 'claude';
}
