import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'state.json');
export const LOGS_DIR = join(DATA_DIR, 'logs');

const projects = new Map();
const tasks = new Map();
const promptTemplates = new Map();
const notificationSettings = new Map(); // projectId|'global' → settings
const runningProcesses = new Map(); // taskId → ChildProcess
const projectLocks = new Set();     // projectIds currently executing
const executionQueues = new Map();  // projectId → taskId[]

// --- Autoclicker ---
const autoclickerConfig = {
  enabled: false,
  enabledProjects: new Set(),
  maxParallel: 3,
  standoffSeconds: 0,
  running: false,
};
const autoclickerAuditLog = []; // { timestamp, projectId, action, targetTaskId, reasoning }
const worktreeLocks = new Map(); // worktreePath → taskId
const autoclickerCycleCount = new Map(); // projectId → number
const autoclickerConsecutiveFailures = new Map(); // projectId → number

// --- Persistence ---

let _dirty = false;
let _debounceTimer = null;
let _writing = false;
const DEBOUNCE_MS = 500;

function _serialize() {
  return JSON.stringify({
    projects: [...projects.values()],
    tasks: [...tasks.values()],
    promptTemplates: [...promptTemplates.values()],
    notificationSettings: Object.fromEntries(notificationSettings),
    executionQueues: Object.fromEntries(executionQueues),
    autoclicker: {
      enabled: autoclickerConfig.enabled,
      enabledProjects: [...autoclickerConfig.enabledProjects],
      maxParallel: autoclickerConfig.maxParallel,
      standoffSeconds: autoclickerConfig.standoffSeconds,
    },
  }, null, 2);
}

function save() {
  _dirty = true;
  if (!_debounceTimer) {
    _debounceTimer = setTimeout(_writeToDisk, DEBOUNCE_MS);
  }
}

async function _writeToDisk() {
  _debounceTimer = null;
  if (!_dirty || _writing) return;
  _dirty = false;
  _writing = true;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, _serialize());
  } catch (err) {
    console.error('Failed to save state:', err.message);
    _dirty = true; // mark dirty again so next debounce retries
  } finally {
    _writing = false;
    // If dirtied again during the write, schedule another
    if (_dirty && !_debounceTimer) {
      _debounceTimer = setTimeout(_writeToDisk, DEBOUNCE_MS);
    }
  }
}

export async function flushState() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_dirty || _writing) {
    // If a write is in progress, wait for it, then check dirty again
    while (_writing) {
      await new Promise(r => setTimeout(r, 10));
    }
    if (_dirty) {
      await _writeToDisk();
    }
  }
}

export function load() {
  // Clear existing state so load() is safely re-callable (needed for tests)
  projects.clear();
  tasks.clear();
  promptTemplates.clear();
  notificationSettings.clear();
  executionQueues.clear();

  try {
    const raw = readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    for (const p of data.projects || []) projects.set(p.id, p);
    for (const t of data.tasks || []) tasks.set(t.id, t);
    for (const pt of data.promptTemplates || []) promptTemplates.set(pt.id, pt);
    if (data.notificationSettings) {
      for (const [key, val] of Object.entries(data.notificationSettings)) {
        notificationSettings.set(key, val);
      }
    }
    if (data.executionQueues) {
      for (const [projectId, queue] of Object.entries(data.executionQueues)) {
        if (Array.isArray(queue) && queue.length > 0) {
          executionQueues.set(projectId, queue);
        }
      }
    }
    // Restore autoclicker config (but never auto-resume running)
    if (data.autoclicker) {
      autoclickerConfig.enabled = !!data.autoclicker.enabled;
      autoclickerConfig.enabledProjects = new Set(data.autoclicker.enabledProjects || []);
      autoclickerConfig.maxParallel = data.autoclicker.maxParallel || 3;
      autoclickerConfig.standoffSeconds = data.autoclicker.standoffSeconds || 0;
      autoclickerConfig.running = false; // Never auto-resume
    }

    // Backfill sortOrder for existing projects missing it
    let needsSortBackfill = false;
    for (const p of projects.values()) {
      if (p.sortOrder == null) { needsSortBackfill = true; break; }
    }
    if (needsSortBackfill) {
      let idx = 0;
      for (const p of projects.values()) {
        if (p.sortOrder == null) p.sortOrder = idx;
        idx++;
      }
    }

    // Backfill sortOrder for existing tasks missing it
    let needsTaskSortBackfill = false;
    for (const t of tasks.values()) {
      if (t.sortOrder == null) { needsTaskSortBackfill = true; break; }
    }
    if (needsTaskSortBackfill) {
      let idx = 0;
      for (const t of tasks.values()) {
        if (t.sortOrder == null) t.sortOrder = t.createdAt || idx;
        idx++;
      }
    }

    console.log(`Loaded ${projects.size} projects, ${tasks.size} tasks, ${promptTemplates.size} templates from disk`);

    // Recover tasks stuck in transient states from a previous server crash
    let recovered = 0;
    for (const t of tasks.values()) {
      if (t.status === 'executing') {
        t.status = t.plan ? 'planned' : 'proposed';
        t.agentLog = (t.agentLog ? t.agentLog + '\n' : '') + '[Server restarted — execution was interrupted]';
        recovered++;
      } else if (t.status === 'planning') {
        t.status = 'proposed';
        recovered++;
      } else if (t.status === 'queued') {
        t.status = t.plan ? 'planned' : 'proposed';
        t.agentLog = (t.agentLog ? t.agentLog + '\n' : '') + '[Server restarted — task was dequeued]';
        recovered++;
      }
    }
    if (recovered > 0) {
      executionQueues.clear();
      console.log(`Recovered ${recovered} task(s) stuck in transient states`);
      save();
    }
  } catch {
    // No file yet or corrupt — start fresh
  }
}

load();

// --- Projects ---

export function addProject({ name, path, url, testCommand }) {
  const id = randomUUID();
  const project = { id, name: name || path.split('/').filter(Boolean).pop(), path, url: url || null, testCommand: testCommand || null, autoTestOnCommit: false, lastTestResult: null, lastRailwayResult: null, budgetLimitUsd: null, branchStrategy: 'direct', sortOrder: projects.size };
  projects.set(id, project);
  save();
  return project;
}

export function updateProject(id, updates) {
  const project = projects.get(id);
  if (!project) return null;
  Object.assign(project, updates);
  save();
  return project;
}

export function getProjects() {
  return [...projects.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export function reorderProjects(orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    const project = projects.get(orderedIds[i]);
    if (project) project.sortOrder = i;
  }
  save();
}

export function getProject(id) {
  return projects.get(id);
}

export function removeProject(id) {
  projects.delete(id);
  executionQueues.delete(id);
  for (const [taskId, task] of tasks) {
    if (task.projectId === id) tasks.delete(taskId);
  }
  save();
}

export function addTask({ projectId, title, description, rationale, effort, generatedBy }) {
  const id = randomUUID();
  const task = {
    id,
    projectId,
    title,
    description,
    rationale: rationale || '',
    effort: effort || 'medium',
    status: 'proposed',
    generatedBy: generatedBy || null,
    plannedBy: null,
    plan: null,
    executedBy: null,
    commitHash: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    agentLog: null,
    diff: null,
    tokenUsage: null,
    costUsd: 0,
    createdAt: Date.now(),
    sortOrder: Date.now(),
  };
  tasks.set(id, task);
  save();
  return task;
}

export function getTask(id) {
  return tasks.get(id);
}

export function getTasks(projectId) {
  const all = [...tasks.values()];
  return projectId ? all.filter(t => t.projectId === projectId) : all;
}

export function getProjectCostSummary(projectId) {
  const projectTasks = getTasks(projectId);
  let totalCost = 0;
  const costByEffort = { small: 0, medium: 0, large: 0 };
  const costTimeline = [];

  for (const t of projectTasks) {
    const cost = t.costUsd || 0;
    totalCost += cost;
    if (t.effort in costByEffort) costByEffort[t.effort] += cost;
    if (cost > 0) {
      costTimeline.push({ timestamp: t.createdAt, cost });
    }
  }

  costTimeline.sort((a, b) => a.timestamp - b.timestamp);

  return { totalCost, costByEffort, costTimeline, taskCount: projectTasks.length };
}

export function updateTask(id, updates) {
  const task = tasks.get(id);
  if (!task) return null;
  Object.assign(task, updates);
  save();
  return task;
}

export function reorderTasks(orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    const task = tasks.get(orderedIds[i]);
    if (task) task.sortOrder = i;
  }
  save();
}

export function removeTask(id) {
  const task = tasks.get(id);
  if (task) {
    _removeFromQueueInternal(task.projectId, id);
  }
  const result = tasks.delete(id);
  save();
  return result;
}

// --- Prompt Templates ---

export function addPromptTemplate({ name, content }) {
  const id = randomUUID();
  const template = { id, name, content, createdAt: Date.now() };
  promptTemplates.set(id, template);
  save();
  return template;
}

export function getPromptTemplates() {
  return [...promptTemplates.values()];
}

export function getPromptTemplate(id) {
  return promptTemplates.get(id);
}

export function removePromptTemplate(id) {
  const result = promptTemplates.delete(id);
  save();
  return result;
}

export function setProcess(taskId, proc) {
  runningProcesses.set(taskId, proc);
}

export function getProcess(taskId) {
  return runningProcesses.get(taskId);
}

export function removeProcess(taskId) {
  runningProcesses.delete(taskId);
}

export function getAllProcesses() {
  return [...runningProcesses.entries()]; // returns [taskId, proc][]
}

export function getAllExecutingTaskIds() {
  return [...tasks.values()]
    .filter(t => t.status === 'executing' || t.status === 'planning')
    .map(t => t.id);
}

export function clearAllQueues() {
  const result = [];
  for (const [projectId, queue] of executionQueues) {
    for (const taskId of queue) {
      const t = tasks.get(taskId);
      if (t) {
        t.status = t.plan ? 'planned' : 'proposed';
        delete t.queuePosition;
        result.push(taskId);
      }
    }
  }
  executionQueues.clear();
  save();
  return result;
}

const abortedTasks = new Set();

export function markAborted(taskId) {
  abortedTasks.add(taskId);
}

export function wasAborted(taskId) {
  return abortedTasks.has(taskId);
}

export function clearAborted(taskId) {
  abortedTasks.delete(taskId);
}

export function lockProject(projectId) {
  if (projectLocks.has(projectId)) return false;
  projectLocks.add(projectId);
  return true;
}

export function unlockProject(projectId) {
  projectLocks.delete(projectId);
}

export function isProjectLocked(projectId) {
  return projectLocks.has(projectId);
}

// --- Execution Queue ---

function _reindexQueuePositions(projectId) {
  const queue = executionQueues.get(projectId);
  if (!queue) return;
  for (let i = 0; i < queue.length; i++) {
    const t = tasks.get(queue[i]);
    if (t) t.queuePosition = i + 1;
  }
}

function _removeFromQueueInternal(projectId, taskId) {
  const queue = executionQueues.get(projectId);
  if (!queue) return false;
  const idx = queue.indexOf(taskId);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) {
    executionQueues.delete(projectId);
  }
  // Clear queuePosition on the removed task
  const t = tasks.get(taskId);
  if (t) delete t.queuePosition;
  // Reindex remaining tasks
  _reindexQueuePositions(projectId);
  return true;
}

export function enqueueTask(projectId, taskId) {
  let queue = executionQueues.get(projectId);
  if (!queue) {
    queue = [];
    executionQueues.set(projectId, queue);
  }
  if (!queue.includes(taskId)) {
    const taskOrder = tasks.get(taskId)?.sortOrder ?? Infinity;
    let insertIdx = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const existingOrder = tasks.get(queue[i])?.sortOrder ?? Infinity;
      if (taskOrder < existingOrder) { insertIdx = i; break; }
    }
    queue.splice(insertIdx, 0, taskId);
  }
  _reindexQueuePositions(projectId);
  save();
  return queue.length;
}

export function dequeueTask(projectId) {
  const queue = executionQueues.get(projectId);
  if (!queue || queue.length === 0) return null;
  const taskId = queue.shift();
  // Clear queuePosition on dequeued task
  const t = tasks.get(taskId);
  if (t) delete t.queuePosition;
  if (queue.length === 0) {
    executionQueues.delete(projectId);
  } else {
    _reindexQueuePositions(projectId);
  }
  save();
  return taskId;
}

export function getQueue(projectId) {
  return executionQueues.get(projectId) || [];
}

export function removeFromQueue(projectId, taskId) {
  const removed = _removeFromQueueInternal(projectId, taskId);
  if (removed) save();
  return removed;
}

export function getQueueSnapshot(projectId) {
  const queue = executionQueues.get(projectId) || [];
  return {
    projectId,
    queue: queue.map((taskId, i) => ({ taskId, position: i + 1 })),
  };
}

export function getAllQueues() {
  const result = {};
  for (const [projectId, queue] of executionQueues) {
    result[projectId] = queue.map((taskId, i) => ({ taskId, position: i + 1 }));
  }
  return result;
}

export function getTaskQueuePosition(taskId) {
  for (const [projectId, queue] of executionQueues) {
    const idx = queue.indexOf(taskId);
    if (idx !== -1) return { projectId, position: idx + 1, total: queue.length };
  }
  return null;
}

// --- Notification Settings ---

function defaultNotificationSettings() {
  return {
    enabled: false,
    browserNotifications: true,
    webhookUrl: '',
    webhookSecret: '',
    slackWebhookUrl: '',
    discordWebhookUrl: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    emailRecipients: '',
    emailDigestEnabled: false,
    emailDigestHour: 9,
    desktopNotifications: false,
    events: {
      taskCompleted: true,
      taskFailed: true,
      allTasksDone: true,
      testFailure: true,
      budgetExceeded: false,
      costThresholdExceeded: false,
    },
    costThresholdUsd: null,
  };
}

export function getNotificationSettings(projectId) {
  return notificationSettings.get(projectId || 'global') || defaultNotificationSettings();
}

export function updateNotificationSettings(projectId, updates) {
  const current = getNotificationSettings(projectId);
  const merged = { ...current, ...updates };
  if (updates.events) merged.events = { ...current.events, ...updates.events };
  notificationSettings.set(projectId || 'global', merged);
  save();
  return merged;
}

// --- Autoclicker Config & State ---

export function getAutoclickerConfig() {
  return {
    enabled: autoclickerConfig.enabled,
    enabledProjects: [...autoclickerConfig.enabledProjects],
    maxParallel: autoclickerConfig.maxParallel,
    standoffSeconds: autoclickerConfig.standoffSeconds,
    running: autoclickerConfig.running,
  };
}

export function setAutoclickerConfig(updates) {
  if ('enabled' in updates) autoclickerConfig.enabled = !!updates.enabled;
  if ('enabledProjects' in updates) {
    autoclickerConfig.enabledProjects = new Set(Array.isArray(updates.enabledProjects) ? updates.enabledProjects : []);
  }
  if ('maxParallel' in updates) autoclickerConfig.maxParallel = updates.maxParallel;
  if ('standoffSeconds' in updates) autoclickerConfig.standoffSeconds = updates.standoffSeconds;
  if ('running' in updates) autoclickerConfig.running = !!updates.running;
  save();
}

const AUDIT_LOG_MAX = 500;

export function addAuditEntry({ projectId, action, targetTaskId, templateId, reasoning, costUsd, inputTokens, outputTokens, durationMs }) {
  const entry = { timestamp: Date.now(), projectId, action, targetTaskId: targetTaskId || null, templateId: templateId || null, reasoning: reasoning || '', costUsd: costUsd || null, inputTokens: inputTokens || null, outputTokens: outputTokens || null, durationMs: durationMs || null };
  autoclickerAuditLog.push(entry);
  if (autoclickerAuditLog.length > AUDIT_LOG_MAX) {
    autoclickerAuditLog.splice(0, autoclickerAuditLog.length - AUDIT_LOG_MAX);
  }
  return entry;
}

export function getAuditLog(limit = 50) {
  return autoclickerAuditLog.slice(-limit);
}

export function lockWorktree(worktreePath, taskId) {
  if (worktreeLocks.has(worktreePath)) return false;
  worktreeLocks.set(worktreePath, taskId);
  return true;
}

export function unlockWorktree(worktreePath) {
  worktreeLocks.delete(worktreePath);
}

export function getActiveWorktreeCount() {
  return worktreeLocks.size;
}

export function getAutoclickerCycleCount(projectId) {
  return autoclickerCycleCount.get(projectId) || 0;
}

export function incrementCycleCount(projectId) {
  autoclickerCycleCount.set(projectId, (autoclickerCycleCount.get(projectId) || 0) + 1);
}

export function resetCycleCount(projectId) {
  autoclickerCycleCount.delete(projectId);
}

export function getConsecutiveFailures(projectId) {
  return autoclickerConsecutiveFailures.get(projectId) || 0;
}

export function incrementConsecutiveFailures(projectId) {
  autoclickerConsecutiveFailures.set(projectId, (autoclickerConsecutiveFailures.get(projectId) || 0) + 1);
}

export function resetConsecutiveFailures(projectId) {
  autoclickerConsecutiveFailures.delete(projectId);
}

// --- Graceful shutdown: flush pending state ---

process.on('beforeExit', async () => {
  await flushState();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flushState();
    process.exit(0);
  });
}

// Synchronous last-resort fallback — if somehow still dirty at exit
process.on('exit', () => {
  if (_dirty) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(DATA_FILE, _serialize());
    } catch (err) {
      console.error('Failed to save state on exit:', err.message);
    }
  }
});
