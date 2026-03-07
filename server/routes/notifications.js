import { Router } from 'express';
import { getNotificationSettings, updateNotificationSettings } from '../state.js';
import { broadcast } from '../ws.js';
import { emitNotification, addSSEClient, removeSSEClient, sendSlackNotification, sendDiscordNotification, sendEmailNotification } from '../notifications.js';
import { resolveAndValidate } from '../netguard.js';

const router = Router();

// Get notification settings
router.get('/notifications/settings', (req, res) => {
  const settings = getNotificationSettings(req.query.projectId || null);
  // Mask secrets in response
  const masked = { ...settings };
  if (masked.webhookSecret) masked.webhookSecret = '****';
  if (masked.smtpPass) masked.smtpPass = '****';
  res.json(masked);
});

// Update notification settings
router.patch('/notifications/settings', async (req, res) => {
  const { projectId, ...updates } = req.body;

  // Validate generic webhook URL if provided
  if (updates.webhookUrl && updates.webhookUrl.trim()) {
    try {
      await resolveAndValidate(updates.webhookUrl.trim());
    } catch (err) {
      return res.status(400).json({ error: `Invalid webhook URL: ${err.message}` });
    }
  }

  // Validate Slack webhook URL
  if (updates.slackWebhookUrl && updates.slackWebhookUrl.trim()) {
    try {
      const { parsed } = await resolveAndValidate(updates.slackWebhookUrl.trim());
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Slack webhook URL must be HTTPS' });
      }
    } catch (err) {
      return res.status(400).json({ error: `Invalid Slack webhook URL: ${err.message}` });
    }
  }

  // Validate Discord webhook URL
  if (updates.discordWebhookUrl && updates.discordWebhookUrl.trim()) {
    try {
      const { parsed } = await resolveAndValidate(updates.discordWebhookUrl.trim());
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Discord webhook URL must be HTTPS' });
      }
    } catch (err) {
      return res.status(400).json({ error: `Invalid Discord webhook URL: ${err.message}` });
    }
  }

  // Validate SMTP port if provided
  if (updates.smtpPort != null && (updates.smtpPort < 1 || updates.smtpPort > 65535)) {
    return res.status(400).json({ error: 'Invalid SMTP port' });
  }

  const updated = updateNotificationSettings(projectId || null, updates);
  broadcast('notification-settings:updated', { projectId: projectId || 'global', settings: updated });
  res.json(updated);
});

// Send a test notification (all channels)
router.post('/notifications/test', async (req, res) => {
  const { projectId } = req.body;
  await emitNotification('test:notification', {
    projectId: projectId || null,
    message: 'This is a test notification from PlateSpinner',
  });
  res.json({ sent: true });
});

// Test Slack webhook specifically
router.post('/notifications/test-slack', async (req, res) => {
  const { projectId } = req.body;
  const settings = getNotificationSettings(projectId || null);
  if (!settings.slackWebhookUrl) {
    return res.status(400).json({ error: 'No Slack webhook URL configured' });
  }
  try {
    const notification = {
      type: 'test:notification',
      timestamp: Date.now(),
      projectId: projectId || null,
      projectName: 'Test',
      message: 'This is a test Slack notification from PlateSpinner',
    };
    await sendSlackNotification(settings.slackWebhookUrl, notification);
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: `Slack test failed: ${err.message}` });
  }
});

// Test Discord webhook specifically
router.post('/notifications/test-discord', async (req, res) => {
  const { projectId } = req.body;
  const settings = getNotificationSettings(projectId || null);
  if (!settings.discordWebhookUrl) {
    return res.status(400).json({ error: 'No Discord webhook URL configured' });
  }
  try {
    const notification = {
      type: 'test:notification',
      timestamp: Date.now(),
      projectId: projectId || null,
      projectName: 'Test',
      message: 'This is a test Discord notification from PlateSpinner',
    };
    await sendDiscordNotification(settings.discordWebhookUrl, notification);
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: `Discord test failed: ${err.message}` });
  }
});

// Test email specifically
router.post('/notifications/test-email', async (req, res) => {
  const { projectId } = req.body;
  const settings = getNotificationSettings(projectId || null);
  if (!settings.smtpHost || !settings.emailRecipients) {
    return res.status(400).json({ error: 'SMTP host and email recipients must be configured' });
  }
  try {
    const notification = {
      type: 'test:notification',
      timestamp: Date.now(),
      projectId: projectId || null,
      projectName: 'Test',
      message: 'This is a test email notification from PlateSpinner',
    };
    await sendEmailNotification(settings, notification);
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: `Email test failed: ${err.message}` });
  }
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
