// Example plugin: Task validator that requires tests to pass before marking done
export const name = 'require-tests-pass';
export const version = '1.0.0';
export const description = 'Validates that project tests pass before marking a task as done';

export function activate(context) {
  context.registerTaskValidator('tests-must-pass', async ({ task, project }) => {
    // Skip if auto-test is already enabled (avoid double-testing)
    if (project.autoTestOnCommit) {
      return { valid: true };
    }

    // Skip if no test command configured
    if (!project.testCommand) {
      return { valid: true, message: 'No test command configured — skipping' };
    }

    const { execFile } = await import('child_process');

    try {
      await new Promise((resolve, reject) => {
        execFile('bash', ['-lc', project.testCommand], {
          cwd: project.path,
          timeout: 300000,
        }, (err, stdout, stderr) => {
          if (err) reject(new Error(`Tests failed: ${(stderr || stdout).slice(0, 500)}`));
          else resolve(stdout);
        });
      });
      return { valid: true, message: 'Tests passed' };
    } catch (err) {
      return { valid: false, message: err.message };
    }
  }, { priority: 10 });
}
