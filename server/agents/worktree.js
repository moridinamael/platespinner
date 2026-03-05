import { execFile } from 'child_process';
import { access, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { toWSLPath } from '../paths.js';
import { broadcast } from '../ws.js';

function exec(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function getDefaultBranch(projectPath) {
  const cwd = toWSLPath(projectPath);
  try {
    const ref = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if main exists, then master
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], cwd);
      return 'main';
    } catch {
      return 'master';
    }
  }
}

export async function createWorktree(projectPath, taskId) {
  const cwd = toWSLPath(projectPath);
  const worktreePath = join(cwd, '.worktrees', taskId);
  const branchName = `autoclicker/${taskId}`;

  await exec('git', ['worktree', 'add', worktreePath, '-b', branchName], cwd);

  return { worktreePath, branchName };
}

export async function mergeWorktree(projectPath, taskId, branchName) {
  const cwd = toWSLPath(projectPath);
  const defaultBranch = await getDefaultBranch(projectPath);

  try {
    // Ensure we're on the default branch for merge
    await exec('git', ['checkout', defaultBranch], cwd);
    await exec('git', ['merge', '--ff-only', branchName], cwd);
    broadcast('autoclicker:merge-complete', { taskId, projectId: null });
    return { success: true, conflict: false };
  } catch {
    broadcast('autoclicker:merge-conflict', { taskId, projectId: null, branchName });
    return { success: false, conflict: true };
  }
}

export async function removeWorktree(projectPath, taskId) {
  const cwd = toWSLPath(projectPath);
  const worktreePath = join(cwd, '.worktrees', taskId);

  try {
    await exec('git', ['worktree', 'remove', worktreePath, '--force'], cwd);
  } catch { /* best-effort */ }

  try {
    await exec('git', ['branch', '-d', `autoclicker/${taskId}`], cwd);
  } catch { /* branch may not exist or may be unmerged — that's fine */ }
}

export async function cleanupOrphanedWorktrees(projectPath) {
  const cwd = toWSLPath(projectPath);

  try {
    await exec('git', ['worktree', 'prune'], cwd);
  } catch { /* ignore */ }

  const worktreeDir = join(cwd, '.worktrees');
  try {
    await access(worktreeDir);
    const entries = await readdir(worktreeDir);
    for (const entry of entries) {
      try {
        await rm(join(worktreeDir, entry), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* .worktrees dir doesn't exist — nothing to clean */ }
}
