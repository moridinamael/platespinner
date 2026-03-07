// All valid task statuses
export const STATUSES = ['proposed', 'planning', 'planned', 'queued', 'executing', 'done', 'failed'];

// Guard functions — each returns { allowed: true } or { allowed: false, reason: string }

export function canEdit(task) {
  const allowed = ['proposed', 'planned', 'failed'];
  if (allowed.includes(task.status)) return { allowed: true };
  return { allowed: false, reason: `Cannot edit task with status '${task.status}'` };
}

export function canPlan(task) {
  const allowed = ['proposed', 'failed'];
  if (allowed.includes(task.status)) return { allowed: true };
  return { allowed: false, reason: `Task is ${task.status}, not proposed or failed` };
}

export function canExecute(task) {
  const allowed = ['proposed', 'planned', 'failed'];
  if (allowed.includes(task.status)) return { allowed: true };
  return { allowed: false, reason: `Task is ${task.status}, expected proposed, planned, or failed` };
}

export function canDequeue(task) {
  if (task.status === 'queued') return { allowed: true };
  return { allowed: false, reason: `Task is ${task.status}, not queued` };
}

export function canAbort(task) {
  if (task.status === 'executing') return { allowed: true };
  return { allowed: false, reason: `Task is ${task.status}, not executing` };
}

export function canRetry(task) {
  if (task.status === 'failed') return { allowed: true };
  return { allowed: false, reason: `Task is ${task.status}, not failed` };
}
