import { execFile } from 'child_process';
import * as state from './state.js';
import { broadcast } from './ws.js';
import { toWSLPath } from './paths.js';

const PR_POLL_INTERVAL_MS = 30_000; // 30 seconds
let pollTimer = null;
const activePRs = new Map(); // taskId → { projectId, prNumber }

// Fetch PR status using gh CLI
export async function fetchPRStatus(projectPath, prNumber) {
  const cwd = toWSLPath(projectPath);
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr', 'view', String(prNumber),
      '--json', 'state,mergeable,reviewDecision,statusCheckRollup,url,mergedAt,mergedBy'
    ], { cwd, timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);

        // Map statusCheckRollup to a summary
        let ciStatus = 'unknown';
        if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
          const checks = data.statusCheckRollup;
          const anyFailed = checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
          const anyPending = checks.some(c => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING');
          const allPassed = checks.every(c => c.conclusion === 'SUCCESS');
          if (anyFailed) ciStatus = 'failed';
          else if (anyPending) ciStatus = 'pending';
          else if (allPassed) ciStatus = 'passed';
        }

        resolve({
          state: data.state, // OPEN, CLOSED, MERGED
          ciStatus,
          reviewDecision: data.reviewDecision || null, // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
          mergeable: data.mergeable || null, // MERGEABLE, CONFLICTING, UNKNOWN
          mergedAt: data.mergedAt || null,
          updatedAt: Date.now(),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Register a PR for polling
export function trackPR(taskId, projectId, prNumber) {
  activePRs.set(taskId, { projectId, prNumber });
  ensurePolling();
}

// Untrack a PR (after merge or close)
export function untrackPR(taskId) {
  activePRs.delete(taskId);
  if (activePRs.size === 0) stopPolling();
}

// Start polling if not already running
function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAllPRs, PR_POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollAllPRs() {
  for (const [taskId, { projectId, prNumber }] of activePRs) {
    const task = state.getTask(taskId);
    if (!task || !task.prNumber) {
      activePRs.delete(taskId);
      continue;
    }
    const project = state.getProject(projectId);
    if (!project) {
      activePRs.delete(taskId);
      continue;
    }
    try {
      const prStatus = await fetchPRStatus(project.path, prNumber);
      state.updateTask(taskId, { prStatus });
      broadcast('task:pr-status', { taskId, prStatus });

      // Auto-untrack merged/closed PRs
      if (prStatus.state === 'MERGED' || prStatus.state === 'CLOSED') {
        if (prStatus.state === 'MERGED') {
          state.updateTask(taskId, { merged: true });
          broadcast('task:updated', state.getTask(taskId));
        }
        activePRs.delete(taskId);
      }
    } catch (err) {
      console.error(`PR status poll failed for task ${taskId}:`, err.message);
    }
  }
  if (activePRs.size === 0) stopPolling();
}

// On server start, rehydrate tracking for tasks with open PRs
export function rehydratePRTracking() {
  const allTasks = state.getTasks();
  for (const task of allTasks) {
    if (task.prNumber && (!task.prStatus || task.prStatus.state === 'OPEN')) {
      activePRs.set(task.id, { projectId: task.projectId, prNumber: task.prNumber });
    }
  }
  if (activePRs.size > 0) {
    console.log(`Rehydrated PR tracking for ${activePRs.size} open PR(s)`);
    ensurePolling();
  }
}
