import { broadcast } from './ws.js';
import { getNotificationSettings, getProject, getTasks } from './state.js';

const sseClients = new Set();

export function addSSEClient(res) { sseClients.add(res); }
export function removeSSEClient(res) { sseClients.delete(res); }

// Convert event type like 'task:completed' to camelCase key like 'taskCompleted'
function eventToCamelCase(type) {
  return type
    .replace(/[:.]/g, ' ')
    .replace(/ (\w)/g, (_, c) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toLowerCase());
}

export async function emitNotification(eventType, payload) {
  const projectId = payload.projectId;
  const settings = getNotificationSettings(projectId);

  if (!settings.enabled) return;

  const eventKey = eventToCamelCase(eventType);
  // Only filter known event toggles; allow unknown events (like test:notification) through
  if (settings.events[eventKey] !== undefined && !settings.events[eventKey]) return;

  const project = projectId ? getProject(projectId) : null;
  const notification = {
    type: eventType,
    timestamp: Date.now(),
    projectId: projectId || null,
    projectName: project?.name || 'Unknown',
    ...payload,
  };

  // Channel 1: Browser notification via WebSocket
  if (settings.browserNotifications) {
    broadcast('notification', notification);
  }

  // Channel 2: SSE broadcast
  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  // Channel 3: Webhook POST (fire-and-forget)
  if (settings.webhookUrl) {
    sendWebhook(settings.webhookUrl, settings.webhookSecret, notification).catch((err) => {
      console.error(`Webhook delivery failed: ${err.message}`);
    });
  }

  // Channel 4: Desktop notification via node-notifier (optional)
  if (settings.desktopNotifications) {
    sendDesktopNotification(notification);
  }
}

async function sendWebhook(url, secret, payload) {
  // Validate URL scheme
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https webhook URLs are allowed');
  }

  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };

  if (secret) {
    const { createHmac } = await import('crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  const mod = parsed.protocol === 'https:' ? await import('https') : await import('http');
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Webhook returned ${res.statusCode}`));
        res.resume();
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Webhook timeout'));
    });
    req.write(body);
    req.end();
  });
}

let notifier = null;
async function sendDesktopNotification(notification) {
  try {
    if (!notifier) {
      notifier = (await import('node-notifier')).default;
    }
    const title = `Kanban: ${notification.type}`;
    const message = notification.taskTitle || notification.summary || notification.message || notification.type;
    notifier.notify({ title, message, sound: true });
  } catch {
    // node-notifier not installed — ignore silently
  }
}

export function checkAllTasksDone(projectId) {
  const projectTasks = getTasks(projectId);
  if (projectTasks.length === 0) return false;
  return projectTasks.every((t) => t.status === 'done');
}
