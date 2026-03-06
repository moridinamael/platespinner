// Example plugin: Run project linter after each task execution
export const name = 'lint-on-commit';
export const version = '1.0.0';
export const description = 'Runs project linter after each task execution that produces a commit';

export function activate(context) {
  context.registerPostExecutionHook('lint', async ({ task, project, result }) => {
    if (!result.commitHash) return;

    const { execFile } = await import('child_process');
    const cwd = project.path;

    const lintCommands = [
      { cmd: 'npx', args: ['eslint', '.', '--fix'] },
      { cmd: 'npm', args: ['run', 'lint', '--', '--fix'] },
    ];

    for (const { cmd, args } of lintCommands) {
      try {
        await new Promise((resolve, reject) => {
          execFile(cmd, args, { cwd, timeout: 60000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        context.log(`Linter ran successfully for task ${task.id}`);
        context.broadcast('plugin:lint-completed', { taskId: task.id, success: true });
        return;
      } catch {
        continue;
      }
    }

    context.log(`No linter found for project ${project.name}`);
  }, { priority: 50 });
}
