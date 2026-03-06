// Example plugin: Auto-update CHANGELOG.md after execution
export const name = 'changelog-updater';
export const version = '1.0.0';
export const description = 'Appends task summaries to CHANGELOG.md after execution';

export function activate(context) {
  context.registerPostExecutionHook('changelog', async ({ task, project, result }) => {
    if (!result.commitHash) return;

    const { readFileSync, writeFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const changelogPath = join(project.path, 'CHANGELOG.md');

    const date = new Date().toISOString().split('T')[0];
    const entry = `\n### ${date} — ${task.title}\n\n${task.description || 'No description'}\n\nCommit: \`${result.commitHash?.slice(0, 8)}\`\n`;

    if (existsSync(changelogPath)) {
      const existing = readFileSync(changelogPath, 'utf-8');
      const firstHeading = existing.indexOf('\n#');
      if (firstHeading > -1) {
        const updated = existing.slice(0, firstHeading) + entry + existing.slice(firstHeading);
        writeFileSync(changelogPath, updated);
      } else {
        writeFileSync(changelogPath, existing + entry);
      }
    } else {
      writeFileSync(changelogPath, `# Changelog\n${entry}`);
    }

    context.log(`CHANGELOG.md updated for task: ${task.title}`);
  }, { priority: 200 });
}
