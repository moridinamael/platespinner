import { Router } from 'express';
import { getActivityLog } from '../activityLog.js';

const router = Router();

router.get('/activity', (req, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined;
  const limit = req.query.limit ? Math.min(Math.max(Number(req.query.limit), 1), 100) : 50;

  if (since !== undefined && (isNaN(since) || since < 0)) {
    return res.status(400).json({ error: 'Invalid since parameter: expected a positive timestamp' });
  }
  if (req.query.limit !== undefined && isNaN(Number(req.query.limit))) {
    return res.status(400).json({ error: 'Invalid limit parameter: expected a number' });
  }

  const entries = getActivityLog({ since, limit });
  res.json(entries);
});

export default router;
