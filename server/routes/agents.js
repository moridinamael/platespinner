import { Router } from 'express';
import { getAgentCounts } from '../census.js';

const router = Router();

router.get('/agents/status', (req, res) => {
  res.json(getAgentCounts());
});

export default router;
