import { Router } from 'express';
import * as state from '../state.js';
import { getBuiltInTemplates } from '../agents/prompts.js';

const router = Router();

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
  const template = state.addPromptTemplate({ name, content });
  res.status(201).json(template);
});

router.delete('/templates/:id', (req, res) => {
  const { id } = req.params;
  if (id.startsWith('builtin:')) {
    return res.status(400).json({ error: 'Cannot delete built-in templates' });
  }
  state.removePromptTemplate(id);
  res.status(204).end();
});

export default router;
