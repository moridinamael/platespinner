import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { toWSLPath, EXTRA_PATH_DIRS } from './paths.js';

/**
 * Detect which test framework a project uses.
 * Returns { command, description } or null if none found.
 */
export function detectTestFramework(projectPath) {
  const cwd = toWSLPath(projectPath);

  // 1. package.json scripts.test
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const testScript = pkg.scripts?.test;
      if (testScript && !testScript.includes('no test specified')) {
        return { command: 'npm test', description: `npm test → ${testScript}` };
      }
    } catch { /* ignore parse errors */ }
  }

  // 2. pytest
  if (
    existsSync(join(cwd, 'pytest.ini')) ||
    existsSync(join(cwd, 'conftest.py'))
  ) {
    return { command: 'pytest -v', description: 'pytest -v' };
  }
  const pyprojectPath = join(cwd, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('[tool.pytest')) {
        return { command: 'pytest -v', description: 'pytest -v' };
      }
    } catch { /* ignore */ }
  }

  // 3. Cargo (Rust)
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    return { command: 'cargo test', description: 'cargo test' };
  }

  // 4. Go
  if (existsSync(join(cwd, 'go.mod'))) {
    return { command: 'go test ./...', description: 'go test ./...' };
  }

  // 5. Makefile with test target
  const makefilePath = join(cwd, 'Makefile');
  if (existsSync(makefilePath)) {
    try {
      const content = readFileSync(makefilePath, 'utf-8');
      if (/^test\s*:/m.test(content)) {
        return { command: 'make test', description: 'make test' };
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Validate a user-supplied test command to prevent shell injection.
 * Rejects commands containing shell metacharacters.
 */
export function validateTestCommand(command) {
  if (!command || !command.trim()) {
    return { valid: false, reason: 'Test command cannot be empty' };
  }
  const dangerous = /[;|&$`()><\n\r\0]/;
  if (dangerous.test(command)) {
    return { valid: false, reason: 'Test command contains disallowed shell characters: ; | & $ ` ( ) > <' };
  }
  return { valid: true };
}

/**
 * Extract a summary line from test output for common frameworks.
 */
export function extractSummary(output, passed) {
  const lines = output.split('\n').filter(Boolean);

  // Jest: "Tests: X passed, Y total" or "Test Suites: ..."
  for (const line of lines) {
    if (/Tests:\s+\d+/.test(line) && /passed|failed/.test(line)) return line.trim();
  }

  // pytest: "X passed" or "X failed, Y passed"
  for (const line of lines) {
    if (/=+\s+.*passed/.test(line) || /=+\s+.*failed/.test(line)) return line.trim();
  }

  // cargo test: "test result: ok" or "test result: FAILED"
  for (const line of lines) {
    if (/^test result:/.test(line)) return line.trim();
  }

  // go test: "ok" or "FAIL"
  for (const line of lines) {
    if (/^(ok|FAIL)\s+/.test(line)) return line.trim();
  }

  // Fallback: last non-empty line
  return lines[lines.length - 1] || (passed ? 'Tests passed' : 'Tests failed');
}

/**
 * Run tests for a project. Uses manual testCommand if set, else auto-detects.
 * Always resolves (never rejects) with { passed, summary, output, description }.
 */
export function runTests(project) {
  return new Promise((resolve) => {
    const cwd = toWSLPath(project.path);
    let command, description;

    if (project.testCommand) {
      command = project.testCommand;
      description = `Manual: ${command}`;
      const check = validateTestCommand(command);
      if (!check.valid) {
        return resolve({
          passed: false,
          summary: `Invalid test command: ${check.reason}`,
          output: `Refused to execute: ${command}`,
          description,
        });
      }
    } else {
      const detected = detectTestFramework(project.path);
      if (!detected) {
        return resolve({
          passed: false,
          summary: 'No test framework detected',
          output: '',
          description: null,
        });
      }
      command = detected.command;
      description = `Auto-detected: ${detected.description}`;
    }

    // Use login shell with extra tool dirs so PATH includes go, cargo, etc.
    const env = { ...process.env, PATH: `${EXTRA_PATH_DIRS}:${process.env.PATH || ''}` };
    execFile('bash', ['-lc', command], { cwd, timeout: 300000, env }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      const passed = !err;
      const summary = extractSummary(output, passed);

      resolve({ passed, summary, output, description });
    });
  });
}
