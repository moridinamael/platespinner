import { Router } from 'express';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as state from '../state.js';
import { getBuiltInTemplates, buildGenerationPrompt, buildPlanningPrompt, buildExecutionPrompt } from '../agents/prompts.js';
import { isValidUUID, validateStringField } from '../validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

router.param('id', (req, res, next, value) => {
  if (value.startsWith('builtin:')) return next();
  if (!isValidUUID(value)) {
    return res.status(400).json({ error: 'Invalid template ID format: expected a UUID' });
  }
  next();
});

router.get('/templates', (req, res) => {
  const builtIn = getBuiltInTemplates();
  const custom = state.getPromptTemplates();
  res.json([...builtIn, ...custom]);
});

router.post('/templates', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'name and content are required' });
  }
  const nameErr = validateStringField(name, 'name', { maxLength: 200 });
  if (nameErr) return res.status(400).json({ error: nameErr });
  const contentErr = validateStringField(content, 'content', { maxLength: 50000 });
  if (contentErr) return res.status(400).json({ error: contentErr });
  const template = state.addPromptTemplate({ name, content });
  res.status(201).json(template);
});

router.patch('/templates/:id', (req, res) => {
  const { id } = req.params;
  if (id.startsWith('builtin:')) {
    return res.status(400).json({ error: 'Cannot modify built-in templates' });
  }
  const template = state.getPromptTemplate(id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const { name, content } = req.body;
  const updates = {};
  if (name !== undefined) {
    const nameErr = validateStringField(name, 'name', { maxLength: 200 });
    if (nameErr) return res.status(400).json({ error: nameErr });
    updates.name = name;
  }
  if (content !== undefined) {
    const contentErr = validateStringField(content, 'content', { maxLength: 50000 });
    if (contentErr) return res.status(400).json({ error: contentErr });
    updates.content = content;
  }
  const updated = state.updatePromptTemplate(id, updates);
  res.json(updated);
});

router.delete('/templates/:id', (req, res) => {
  const { id } = req.params;
  if (id.startsWith('builtin:')) {
    return res.status(400).json({ error: 'Cannot delete built-in templates' });
  }
  state.removePromptTemplate(id);
  res.status(204).end();
});

// --- Skill-specific routes ---

router.post('/skills/dry-run', (req, res) => {
  const { content, phase, projectId, taskId } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const project = projectId ? state.getProject(projectId) : null;
  const task = taskId ? state.getTask(taskId) : null;

  let fullPrompt;
  if (phase === 'planning') {
    fullPrompt = buildPlanningPrompt({
      title: task?.title || 'Example Task',
      description: task?.description || 'Example description',
      rationale: task?.rationale || 'Example rationale',
      lastTestOutput: null,
    });
  } else if (phase === 'execution') {
    fullPrompt = buildExecutionPrompt({
      title: task?.title || 'Example Task',
      description: task?.description || 'Example description',
      rationale: task?.rationale || 'Example rationale',
      plan: task?.plan || null,
      branch: task?.branch || null,
      agentLog: null,
      lastTestOutput: null,
    });
  } else {
    // default: generation
    fullPrompt = buildGenerationPrompt(project?.path || '/example/project', content);
  }

  const charCount = fullPrompt.length;
  const wordCount = fullPrompt.split(/\s+/).length;
  const estimatedTokens = Math.ceil(charCount / 4);

  res.json({ prompt: fullPrompt, charCount, wordCount, estimatedTokens });
});

router.post('/skills/export', (req, res) => {
  const { ids } = req.body;
  const builtIns = getBuiltInTemplates();
  const custom = state.getPromptTemplates();
  const all = [...builtIns, ...custom];
  const selected = ids && ids.length > 0 ? all.filter(t => ids.includes(t.id)) : all;

  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    skills: selected.map(t => ({
      name: t.name,
      content: t.content,
      originalId: t.id,
    })),
  };
  res.json(bundle);
});

router.post('/skills/import', (req, res) => {
  const { skills } = req.body;
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'skills array is required and must not be empty' });
  }
  for (const s of skills) {
    if (!s.name || typeof s.name !== 'string' || !s.content || typeof s.content !== 'string') {
      return res.status(400).json({ error: 'Each skill must have a name and content string' });
    }
  }
  const created = skills.map(s => state.addPromptTemplate({ name: s.name, content: s.content }));
  res.status(201).json(created);
});

router.get('/skills/library', (req, res) => {
  const libraryDir = join(__dirname, '..', 'skills', 'community');
  try {
    const files = readdirSync(libraryDir).filter(f => f.endsWith('.json'));
    const skills = files.map(f => {
      const data = JSON.parse(readFileSync(join(libraryDir, f), 'utf-8'));
      return data;
    });
    res.json(skills);
  } catch {
    res.json([]);
  }
});

export default router;
