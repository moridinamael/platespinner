import { Router } from 'express';
import { startOrchestrator, stopOrchestrator, getOrchestratorStatus } from '../agents/autoclicker.js';
import * as state from '../state.js';
import { isValidUUID } from '../validation.js';

const router = Router();

router.post('/autoclicker/start', (req, res) => {
  const { enabledProjectIds, maxParallel, standoffSeconds } = req.body;

  if (!enabledProjectIds || !Array.isArray(enabledProjectIds) || enabledProjectIds.length === 0) {
    return res.status(400).json({ error: 'enabledProjectIds must be a non-empty array' });
  }
  const invalidId = enabledProjectIds.find(id => !isValidUUID(id));
  if (invalidId) {
    return res.status(400).json({ error: `Invalid project ID format: ${invalidId}` });
  }

  const mp = Math.min(Math.max(parseInt(maxParallel) || 3, 1), 10);
  const ss = Math.max(parseFloat(standoffSeconds) || 0, 0);

  for (const id of enabledProjectIds) {
    if (!state.getProject(id)) {
      return res.status(404).json({ error: `Project not found: ${id}` });
    }
  }

  try {
    startOrchestrator({ enabledProjectIds, maxParallel: mp, standoffSeconds: ss });
    res.json({ message: 'Autoclicker started', maxParallel: mp, standoffSeconds: ss, projects: enabledProjectIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/autoclicker/stop', (req, res) => {
  stopOrchestrator();
  res.json({ message: 'Autoclicker stopping (in-flight processes will complete)' });
});

router.get('/autoclicker/status', (req, res) => {
  res.json(getOrchestratorStatus());
});

export default router;
