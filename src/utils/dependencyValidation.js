// Walks transitive dependencies from newDepId using the provided tasks array.
// Returns true if sourceTaskId appears anywhere in the transitive closure,
// which would make "source depends on newDepId" a cycle.
//
// To account for unsaved draft edits on the source task, callers should pass
// an allTasks array where the source's entry has its draft dependencies merged
// in (see DependencyEditor.jsx for the standard pattern).
export function wouldCreateCycle(sourceTaskId, newDepId, allTasks) {
  if (sourceTaskId === newDepId) return true;
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const visited = new Set();
  const stack = [newDepId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === sourceTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const t = taskMap.get(current);
    if (t && Array.isArray(t.dependencies)) {
      for (const d of t.dependencies) stack.push(d);
    }
  }
  return false;
}
