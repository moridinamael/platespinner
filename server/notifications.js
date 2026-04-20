import { broadcast } from './ws.js';
import { getNotificationSettings, getProject, getTasks } from './state.js';
import { resolveAndValidate } from './netguard.js';

const sseClients = new Set();

export function addSSEClient(res) { sseClients.add(res); }
export function removeSSEClient(res) { sseClients.delete(res); }

// Dedup guards — prevent rapid-fire duplicate notifications
const lastBudgetNotification = new Map(); // projectId → timestamp
const costThresholdCrossed = new Set();   // projectId values that already fired

export function resetCostThresholdFlag(projectId) {
  costThresholdCrossed.delete(projectId);
}

// Convert event type like 'task:completed' to camelCase key like 'taskCompleted'
function eventToCamelCase(type) {
  return type
    .replace(/[:.]/g, ' ')
    .replace(/ (\w)/g, (_, c) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toLowerCase());
}

// --- Shared formatters ---

function formatNotificationTitle(notification) {
  const titles = {
    'task:completed': 'Task Completed',
    'task:failed': 'Task Failed',
    'all-tasks:done': 'All Tasks Done',
    'test:failure': 'Tests Failed',
    'budget:exceeded': 'Budget Exceeded',
    'cost:threshold-exceeded': 'Cost Threshold Exceeded',
    'test:notification': 'Test Notification',
  };
  return titles[notification.type] || 'PlateSpinner Notification';
}

function formatNotificationBody(notification) {
  if (notification.taskTitle) return notification.taskTitle;
  if (notification.summary) return notification.summary;
  if (notification.message) return notification.message;
  return notification.type;
}

// --- HTTP POST helper ---

async function postJSON(url, payload, headers = {}) {
  const { parsed, resolvedAddress } = await resolveAndValidate(url);
  const body = JSON.stringify(payload);
  const allHeaders = { 'Content-Type': 'application/json', 'Host': parsed.hostname, ...headers };

  const mod = parsed.protocol === 'https:' ? await import('https') : await import('http');
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: resolvedAddress,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: allHeaders,
      timeout: 10000,
      servername: parsed.hostname,
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`HTTP ${res.statusCode}`));
      res.resume();
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// --- Channel senders ---

async function sendWebhook(url, secret, payload) {
  const body = JSON.stringify(payload);
  const headers = {};

  if (secret) {
    const { createHmac } = await import('crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  await postJSON(url, payload, headers);
}

async function sendSlackNotification(url, notification) {
  const colorMap = {
    'task:completed': '#36a64f',
    'task:failed': '#ff0000',
    'all-tasks:done': '#2196f3',
    'test:failure': '#ff9800',
    'budget:exceeded': '#ff0000',
    'cost:threshold-exceeded': '#ff9800',
  };
  const color = colorMap[notification.type] || '#808080';

  const payload = {
    attachments: [{
      color,
      fallback: `${notification.projectName}: ${notification.type}`,
      title: formatNotificationTitle(notification),
      text: formatNotificationBody(notification),
      fields: [
        { title: 'Project', value: notification.projectName, short: true },
        { title: 'Event', value: notification.type, short: true },
      ],
      ts: Math.floor(notification.timestamp / 1000),
    }],
  };
  if (notification.taskTitle) {
    payload.attachments[0].fields.push({ title: 'Task', value: notification.taskTitle, short: true });
  }
  if (notification.commitHash) {
    payload.attachments[0].fields.push({ title: 'Commit', value: notification.commitHash.slice(0, 8), short: true });
  }

  await postJSON(url, payload);
}

async function sendDiscordNotification(url, notification) {
  const colorMap = {
    'task:completed': 0x36a64f,
    'task:failed': 0xff0000,
    'all-tasks:done': 0x2196f3,
    'test:failure': 0xff9800,
    'budget:exceeded': 0xff0000,
    'cost:threshold-exceeded': 0xff9800,
  };

  const payload = {
    embeds: [{
      title: formatNotificationTitle(notification),
      description: formatNotificationBody(notification),
      color: colorMap[notification.type] || 0x808080,
      fields: [
        { name: 'Project', value: notification.projectName, inline: true },
        { name: 'Event', value: notification.type, inline: true },
      ],
      timestamp: new Date(notification.timestamp).toISOString(),
    }],
  };
  if (notification.taskTitle) {
    payload.embeds[0].fields.push({ name: 'Task', value: notification.taskTitle, inline: true });
  }

  await postJSON(url, payload);
}

let nodemailerModule = null;
let transporter = null;

async function getTransporter(settings) {
  if (!nodemailerModule) {
    try {
      nodemailerModule = (await import('nodemailer')).default;
    } catch {
      return null; // nodemailer not installed
    }
  }
  const configKey = `${settings.smtpHost}:${settings.smtpPort}:${settings.smtpUser}`;
  if (!transporter || transporter._kanbanConfig !== configKey) {
    transporter = nodemailerModule.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpPort === 465,
      auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPass } : undefined,
    });
    transporter._kanbanConfig = configKey;
  }
  return transporter;
}

export async function sendEmailNotification(settings, notification) {
  if (!settings.smtpHost || !settings.emailRecipients) return;
  try {
    const transport = await getTransporter(settings);
    if (!transport) return; // nodemailer not installed
    const title = formatNotificationTitle(notification);
    const body = formatNotificationBody(notification);
    await transport.sendMail({
      from: settings.smtpFrom || settings.smtpUser || 'kanban@localhost',
      to: settings.emailRecipients,
      subject: `[PlateSpinner] ${title} — ${notification.projectName}`,
      text: `${title}\n\nProject: ${notification.projectName}\nEvent: ${notification.type}\n\n${body}`,
      html: `<h2>${title}</h2><p><strong>Project:</strong> ${notification.projectName}</p><p><strong>Event:</strong> ${notification.type}</p><p>${body}</p>`,
    });
  } catch (err) {
    console.error(`Email delivery failed: ${err.message}`);
  }
}

// Exported for test endpoints
export { sendSlackNotification, sendDiscordNotification, getTransporter, formatNotificationTitle, formatNotificationBody };

let notifier = null;
async function sendDesktopNotification(notification) {
  try {
    if (!notifier) {
      notifier = (await import('node-notifier')).default;
    }
    const title = `PlateSpinner: ${notification.type}`;
    const message = notification.taskTitle || notification.summary || notification.message || notification.type;
    notifier.notify({ title, message, sound: true });
  } catch {
    // node-notifier not installed — ignore silently
  }
}

// --- Main emit ---

export async function emitNotification(eventType, payload) {
  const projectId = payload.projectId;
  const settings = getNotificationSettings(projectId);

  if (!settings.enabled) return;

  // Dedup guard for budget:exceeded — suppress if < 5 min since last
  if (eventType === 'budget:exceeded') {
    const last = lastBudgetNotification.get(projectId);
    if (last && Date.now() - last < 5 * 60 * 1000) return;
    lastBudgetNotification.set(projectId, Date.now());
  }

  // Dedup guard for cost:threshold-exceeded — only fire once per threshold crossing
  if (eventType === 'cost:threshold-exceeded') {
    if (costThresholdCrossed.has(projectId)) return;
    costThresholdCrossed.add(projectId);
  }

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

  // Channel 3: Generic webhook POST (fire-and-forget)
  if (settings.webhookUrl) {
    sendWebhook(settings.webhookUrl, settings.webhookSecret, notification).catch((err) => {
      console.error(`Webhook delivery failed: ${err.message}`);
    });
  }

  // Channel 4: Desktop notification via node-notifier (optional)
  if (settings.desktopNotifications) {
    sendDesktopNotification(notification);
  }

  // Channel 5: Slack webhook
  if (settings.slackWebhookUrl) {
    sendSlackNotification(settings.slackWebhookUrl, notification).catch((err) => {
      console.error(`Slack notification failed: ${err.message}`);
    });
  }

  // Channel 6: Discord webhook
  if (settings.discordWebhookUrl) {
    sendDiscordNotification(settings.discordWebhookUrl, notification).catch((err) => {
      console.error(`Discord notification failed: ${err.message}`);
    });
  }

  // Channel 7: Email (instant — digest handled by digest.js)
  if (settings.smtpHost && settings.emailRecipients && !settings.emailDigestEnabled) {
    sendEmailNotification(settings, notification).catch((err) => {
      console.error(`Email notification failed: ${err.message}`);
    });
  }
}

export function checkAllTasksDone(projectId) {
  const projectTasks = getTasks(projectId);
  if (projectTasks.length === 0) return false;
  return projectTasks.every((t) => t.status === 'done');
}
