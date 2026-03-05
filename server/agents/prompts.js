import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, '..', 'skills');

let paretoSkill, paretoFullSkill, rubricSkill, planningSkill, autoclickerJudgeSkill;

try {
  paretoSkill = readFileSync(join(skillsDir, 'pareto.md'), 'utf-8');
} catch {
  paretoSkill = 'Analyze this project and suggest 3-7 high-impact improvements.';
}

try {
  paretoFullSkill = readFileSync(join(skillsDir, 'pareto-full.md'), 'utf-8');
} catch {
  paretoFullSkill = paretoSkill;
}

try {
  rubricSkill = readFileSync(join(skillsDir, 'rubric.md'), 'utf-8');
} catch {
  rubricSkill = 'Implement the task, verify it works, and commit the changes.';
}

try {
  planningSkill = readFileSync(join(skillsDir, 'planning.md'), 'utf-8');
} catch {
  planningSkill = 'Analyze the codebase and produce a detailed implementation plan for the given task.';
}

try {
  autoclickerJudgeSkill = readFileSync(join(skillsDir, 'autoclicker-judge.md'), 'utf-8');
} catch {
  autoclickerJudgeSkill = 'You are an autonomous project improvement judge. Analyze the project state and decide what action to take next.';
}

export function getBuiltInTemplates() {
  return [
    { id: 'builtin:pareto-simple', name: 'Pareto (Simple)', content: paretoSkill },
    { id: 'builtin:pareto-full', name: 'Pareto (Full Framework)', content: paretoFullSkill },
  ];
}

export function buildGenerationPrompt(projectPath, skillContent) {
  const skill = skillContent || paretoSkill;
  return `${skill}

---

Analyze the project at the current working directory: ${projectPath}

Scan the codebase, identify improvement opportunities, and return your proposals.

IMPORTANT: Your output MUST contain a JSON array wrapped in <task-proposals> tags exactly as specified in the instructions above. Do not output anything after the closing </task-proposals> tag.`;
}

export function buildTestSetupPrompt(projectPath, testInfo) {
  const context = testInfo?.description
    ? `Current detection status: ${testInfo.description}`
    : 'No test framework currently detected.';

  return `You are a focused test-setup agent. Your ONLY job is to ensure this project has a working, minimal test suite that passes when run.

## Project
Working directory: ${projectPath}
${context}

## Instructions

1. Analyze the project structure, language, and frameworks used.
2. Check if tests already exist but are broken or misconfigured.
3. Based on what you find, either:
   a. **Fix** the existing test configuration if tests exist but don't work.
   b. **Create** a minimal test setup if none exists.

## Compatibility Requirements

The test runner detects frameworks in this order — your setup MUST be compatible:

- **Node.js**: Set \`scripts.test\` in package.json (NOT the default "no test specified" placeholder). Use the project's existing test framework (Jest, Vitest, Mocha, etc.) or add one if needed. \`npm test\` must work.
- **Python**: Ensure \`pytest -v\` works. Add pytest.ini, conftest.py, or [tool.pytest] in pyproject.toml if needed.
- **Rust**: Ensure \`cargo test\` works.
- **Go**: Ensure \`go test ./...\` works.
- **Other**: Add a \`test:\` target to the Makefile.

## Principles

- **Minimal changes.** Don't rewrite existing tests. Fix configuration, add missing dependencies, create small smoke tests if nothing exists.
- **Smoke tests over exhaustive tests.** If creating tests from scratch, write 1-3 tests that verify core imports/modules work. The goal is a green baseline, not full coverage.
- **Don't break anything.** If the project has a working build, it must still work after your changes.
- **Use existing tools.** If the project already has a test framework in devDependencies, use it. Don't switch frameworks.
- **Run the tests** before you're done to verify they pass. If they don't pass, fix them.

## Output

After you're done, git add and commit your changes with a message like "chore: set up minimal test suite".

Then output your result wrapped in tags:

<test-setup-result>
{
  "success": true/false,
  "testCommand": "npm test",
  "summary": "Brief description of what you did",
  "commitHash": "abc1234"
}
</test-setup-result>

IMPORTANT: Your output MUST contain the result wrapped in <test-setup-result> tags. Do not output anything after the closing tag.`;
}

export function buildPlanningPrompt(task) {
  return `${planningSkill}

---

## Task to Plan

**Title:** ${task.title}
**Description:** ${task.description}
**Rationale:** ${task.rationale}

Analyze the codebase at the current working directory and produce a detailed implementation plan for this task.

IMPORTANT: Your output MUST contain the plan wrapped in <implementation-plan> tags exactly as specified in the instructions above. Do not output anything after the closing </implementation-plan> tag.`;
}

export function buildExecutionPrompt(task) {
  const planSection = task.plan
    ? `\n\n## Implementation Plan\n\nA planning agent has already analyzed the codebase and produced the following implementation plan. Follow this plan closely:\n\n${task.plan}\n\n---\n`
    : '';

  const branchSection = task.branch
    ? `\n\n## Branch\n\nYou are working on branch: \`${task.branch}\`. Commit your changes to this branch.\n\n---\n`
    : '';

  const priorAttempt = task.agentLog
    ? `\n\n## Prior Attempt\n\nA previous execution agent attempted this task but failed. There may be partial changes in the working directory. Review the current state before proceeding.\n\n**Agent log:** ${task.agentLog}\n\n---\n`
    : '';

  return `${rubricSkill}

---

## Task to Execute

**Title:** ${task.title}
**Description:** ${task.description}
**Rationale:** ${task.rationale}
${planSection}${branchSection}${priorAttempt}
Implement this task in the current working directory. Follow the rubric process: analyze, create rubric, implement, verify, self-score, then git commit.

IMPORTANT: Your output MUST contain the result wrapped in <execution-result> tags exactly as specified in the instructions above. Do not output anything after the closing </execution-result> tag.`;
}

export function buildJudgmentPrompt(project, tasks, templates, gitLog, testResult) {
  const tasksSummary = tasks.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    effort: t.effort,
    description: t.description?.slice(0, 200),
    plan: t.plan ? 'yes' : 'no',
  }));

  const templatesSummary = templates.map(t => ({ id: t.id, name: t.name }));

  const context = JSON.stringify({
    project: { id: project.id, name: project.name, path: project.path },
    tasks: tasksSummary,
    templates: templatesSummary,
    recentGitLog: gitLog,
    lastTestResult: testResult ? { passed: testResult.passed, summary: testResult.summary } : null,
  }, null, 2);

  return `${autoclickerJudgeSkill}

---

## Current Project State

\`\`\`json
${context}
\`\`\`

Analyze the project state and output your decision.

IMPORTANT: Your output MUST contain the decision wrapped in <autoclicker-decision> tags. Do not output anything after the closing tag.`;
}
