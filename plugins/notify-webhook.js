// Example plugin: Send webhook notifications for execution lifecycle events
export const name = 'notify-webhook';
export const version = '1.0.0';
export const description = 'Sends detailed webhook notifications for execution lifecycle events';

export function activate(context) {
  const webhookUrl = process.env.PLUGIN_WEBHOOK_URL;
  if (!webhookUrl) {
    context.log('PLUGIN_WEBHOOK_URL not set — webhook plugin inactive');
    return;
  }

  context.on('execution:completed', async (data) => {
    const task = context.getTask(data.taskId);
    const project = task ? context.getProject(task.projectId) : null;

    const payload = {
      event: 'task_completed',
      timestamp: Date.now(),
      task: task ? { id: task.id, title: task.title, effort: task.effort, costUsd: task.costUsd } : null,
      project: project ? { id: project.id, name: project.name } : null,
      commitHash: data.commitHash || null,
    };

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      context.log(`Webhook delivery failed: ${err.message}`);
    }
  });

  context.on('execution:failed', async (data) => {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'task_failed', timestamp: Date.now(), taskId: data.taskId, error: data.error }),
      });
    } catch { /* ignore */ }
  });
}
