import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'state.json');

const projects = new Map();
const tasks = new Map();
const promptTemplates = new Map();
const runningProcesses = new Map(); // taskId → ChildProcess
const projectLocks = new Set();     // projectIds currently executing

// --- Persistence ---

function save() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      projects: [...projects.values()],
      tasks: [...tasks.values()],
      promptTemplates: [...promptTemplates.values()],
    };
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
}

function load() {
  try {
    const raw = readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    for (const p of data.projects || []) projects.set(p.id, p);
    for (const t of data.tasks || []) tasks.set(t.id, t);
    for (const pt of data.promptTemplates || []) promptTemplates.set(pt.id, pt);
    console.log(`Loaded ${projects.size} projects, ${tasks.size} tasks, ${promptTemplates.size} templates from disk`);
  } catch {
    // No file yet or corrupt — start fresh
  }
}

load();

// --- Projects ---

export function addProject({ name, path, url, testCommand }) {
  const id = randomUUID();
  const project = { id, name: name || path.split('/').filter(Boolean).pop(), path, url: url || null, testCommand: testCommand || null };
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
  return [...projects.values()];
}

export function getProject(id) {
  return projects.get(id);
}

export function removeProject(id) {
  projects.delete(id);
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
    agentLog: null,
    createdAt: Date.now(),
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

export function updateTask(id, updates) {
  const task = tasks.get(id);
  if (!task) return null;
  Object.assign(task, updates);
  save();
  return task;
}

export function removeTask(id) {
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
