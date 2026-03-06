import { getProjects, getTasks, getNotificationSettings, getProjectCostSummary } from './state.js';
import { sendEmailNotification, formatNotificationTitle } from './notifications.js';

let digestTimer = null;
const lastDigestSent = new Map(); // key → 'YYYY-MM-DD'

export function startDigestScheduler() {
  // Check every 15 minutes if it's time to send a digest
  digestTimer = setInterval(checkAndSendDigests, 15 * 60 * 1000);
  // Also check on startup (delayed 10s to let state load)
  setTimeout(checkAndSendDigests, 10000);
}

export function stopDigestScheduler() {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}

async function checkAndSendDigests() {
  const now = new Date();
  const currentHour = now.getHours();

  // Check global settings
  await maybeSendDigest('global', currentHour, now);

  // Check per-project settings
  for (const project of getProjects()) {
    await maybeSendDigest(project.id, currentHour, now);
  }
}

async function maybeSendDigest(projectId, currentHour, now) {
  const settings = getNotificationSettings(projectId === 'global' ? null : projectId);
  if (!settings.enabled || !settings.emailDigestEnabled || !settings.smtpHost || !settings.emailRecipients) return;

  const digestHour = settings.emailDigestHour ?? 9;
  if (currentHour !== digestHour) return;

  // Don't send more than once per day
  const today = now.toISOString().slice(0, 10);
  if (lastDigestSent.get(projectId) === today) return;
  lastDigestSent.set(projectId, today);

  // Gather data for digest
  const sinceMs = now.getTime() - 24 * 60 * 60 * 1000;
  const projects = projectId === 'global'
    ? getProjects()
    : [getProjects().find(p => p.id === projectId)].filter(Boolean);

  const digestData = projects.map(project => {
    const tasks = getTasks(project.id);
    const completedRecently = tasks.filter(t => t.status === 'done' && t.createdAt >= sinceMs);
    const failedRecently = tasks.filter(t => t.status === 'failed' || (t.agentLog && t.agentLog.includes('failed')));
    const costSummary = getProjectCostSummary(project.id);
    return { project, completedRecently, failedRecently, costSummary };
  });

  if (digestData.every(d => d.completedRecently.length === 0 && d.failedRecently.length === 0)) {
    return; // Nothing to report
  }

  await sendDigestEmail(settings, digestData);
}

async function sendDigestEmail(settings, digestData) {
  const totalCompleted = digestData.reduce((sum, d) => sum + d.completedRecently.length, 0);
  const totalCost = digestData.reduce((sum, d) => sum + d.costSummary.totalCost, 0);

  // Build plain text
  let text = `PlateSpinner Daily Digest\n${'='.repeat(40)}\n\n`;
  text += `Summary: ${totalCompleted} tasks completed, $${totalCost.toFixed(2)} total cost\n\n`;

  for (const { project, completedRecently, failedRecently, costSummary } of digestData) {
    text += `--- ${project.name} ---\n`;
    text += `Completed (last 24h): ${completedRecently.length}\n`;
    if (completedRecently.length > 0) {
      for (const t of completedRecently) {
        text += `  - ${t.title} ($${(t.costUsd || 0).toFixed(2)})${t.commitHash ? ` [${t.commitHash.slice(0, 8)}]` : ''}\n`;
      }
    }
    if (failedRecently.length > 0) {
      text += `Failed: ${failedRecently.length}\n`;
      for (const t of failedRecently) {
        text += `  - ${t.title}\n`;
      }
    }
    text += `Total cost: $${costSummary.totalCost.toFixed(2)} across ${costSummary.taskCount} tasks\n`;
    if (project.budgetLimitUsd) {
      text += `Budget: $${costSummary.totalCost.toFixed(2)} / $${project.budgetLimitUsd.toFixed(2)}\n`;
    }
    text += '\n';
  }

  // Build HTML
  let html = `<h1>PlateSpinner Daily Digest</h1>`;
  html += `<p><strong>${totalCompleted}</strong> tasks completed | <strong>$${totalCost.toFixed(2)}</strong> total cost</p>`;

  for (const { project, completedRecently, failedRecently, costSummary } of digestData) {
    html += `<h2>${escapeHtml(project.name)}</h2>`;
    if (completedRecently.length > 0) {
      html += `<h3>Completed (last 24h)</h3><table border="1" cellpadding="4" cellspacing="0"><tr><th>Task</th><th>Cost</th><th>Commit</th></tr>`;
      for (const t of completedRecently) {
        html += `<tr><td>${escapeHtml(t.title)}</td><td>$${(t.costUsd || 0).toFixed(2)}</td><td>${t.commitHash ? t.commitHash.slice(0, 8) : '-'}</td></tr>`;
      }
      html += `</table>`;
    }
    if (failedRecently.length > 0) {
      html += `<h3>Failed</h3><ul>`;
      for (const t of failedRecently) {
        html += `<li>${escapeHtml(t.title)}</li>`;
      }
      html += `</ul>`;
    }
    html += `<p>Total cost: $${costSummary.totalCost.toFixed(2)} across ${costSummary.taskCount} tasks`;
    if (project.budgetLimitUsd) {
      html += ` | Budget: $${costSummary.totalCost.toFixed(2)} / $${project.budgetLimitUsd.toFixed(2)}`;
    }
    html += `</p>`;
  }

  // Use the email sender from notifications.js via a digest-shaped notification
  const notification = {
    type: 'digest',
    timestamp: Date.now(),
    projectId: null,
    projectName: 'Daily Digest',
    message: `${totalCompleted} tasks completed, $${totalCost.toFixed(2)} total cost`,
  };

  // Send raw email via nodemailer
  try {
    const { getTransporter } = await import('./notifications.js');
    const transport = await getTransporter(settings);
    if (!transport) return;
    await transport.sendMail({
      from: settings.smtpFrom || settings.smtpUser || 'kanban@localhost',
      to: settings.emailRecipients,
      subject: `[PlateSpinner] Daily Digest — ${totalCompleted} tasks, $${totalCost.toFixed(2)}`,
      text,
      html,
    });
  } catch (err) {
    console.error(`Digest email failed: ${err.message}`);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
