/**
 * Render PR body from template or default format.
 * Template variables: {{title}}, {{description}}, {{rationale}}, {{plan}}
 */
export function renderPRBody(template, task) {
  if (!template) {
    let body = `## ${task.title}\n\n${task.description || ''}`;
    if (task.rationale) body += `\n\n**Rationale:** ${task.rationale}`;
    if (task.plan) body += `\n\n<details><summary>Implementation Plan</summary>\n\n${task.plan}\n\n</details>`;
    return body;
  }
  return template
    .replace(/\{\{title\}\}/g, task.title || '')
    .replace(/\{\{description\}\}/g, task.description || '')
    .replace(/\{\{rationale\}\}/g, task.rationale || '')
    .replace(/\{\{plan\}\}/g, task.plan || '');
}
