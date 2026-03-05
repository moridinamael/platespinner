import { Router } from 'express';
import { getNotificationSettings, updateNotificationSettings } from '../state.js';
import { broadcast } from '../ws.js';
import { emitNotification, addSSEClient, removeSSEClient } from '../notifications.js';

const router = Router();

// Get notification settings
router.get('/notifications/settings', (req, res) => {
  const settings = getNotificationSettings(req.query.projectId || null);
  // Mask webhook secret in response
  const masked = { ...settings };
  if (masked.webhookSecret) masked.webhookSecret = '****';
  res.json(masked);
});

// Update notification settings
router.patch('/notifications/settings', (req, res) => {
  const { projectId, ...updates } = req.body;

  // Validate webhook URL if provided
  if (updates.webhookUrl && updates.webhookUrl.trim()) {
    try {
      const parsed = new URL(updates.webhookUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only http/https webhook URLs are allowed' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }
  }

  const updated = updateNotificationSettings(projectId || null, updates);
  broadcast('notification-settings:updated', { projectId: projectId || 'global', settings: updated });
  res.json(updated);
});

// Send a test notification
router.post('/notifications/test', async (req, res) => {
  const { projectId } = req.body;
  await emitNotification('test:notification', {
    projectId: projectId || null,
    message: 'This is a test notification from Kanban Agents',
  });
  res.json({ sent: true });
});

// Server-Sent Events endpoint
router.get('/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n'); // initial comment to establish connection

  addSSEClient(res);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      removeSSEClient(res);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(res);
  });
});

export default router;
