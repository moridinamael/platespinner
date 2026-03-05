import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateTestCommand, detectTestFramework, extractSummary } from './testing.js';

// --- Temp directory helpers ---
const tempDirs = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'testing-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// =============================================================================
// validateTestCommand
// =============================================================================
describe('validateTestCommand', () => {
  // --- Valid commands ---
  it('accepts simple test commands', () => {
    expect(validateTestCommand('npm test')).toEqual({ valid: true });
    expect(validateTestCommand('pytest -v')).toEqual({ valid: true });
    expect(validateTestCommand('cargo test')).toEqual({ valid: true });
    expect(validateTestCommand('go test ./...')).toEqual({ valid: true });
    expect(validateTestCommand('make test')).toEqual({ valid: true });
  });

  it('accepts commands with flags containing dashes and equals', () => {
    expect(validateTestCommand('pytest --timeout=30')).toEqual({ valid: true });
    expect(validateTestCommand('npm test -- --coverage')).toEqual({ valid: true });
    expect(validateTestCommand('cargo test --release --no-fail-fast')).toEqual({ valid: true });
  });

  // --- Dangerous metacharacters ---
  it('rejects semicolons', () => {
    expect(validateTestCommand('npm test; rm -rf /').valid).toBe(false);
  });

  it('rejects pipes', () => {
    expect(validateTestCommand('npm test | cat').valid).toBe(false);
  });

  it('rejects ampersands', () => {
    expect(validateTestCommand('npm test && echo pwned').valid).toBe(false);
  });

  it('rejects backticks', () => {
    expect(validateTestCommand('npm test `whoami`').valid).toBe(false);
  });

  it('rejects $() subshells', () => {
    expect(validateTestCommand('npm test $(whoami)').valid).toBe(false);
    expect(validateTestCommand('${PATH}').valid).toBe(false);
  });

  it('rejects parentheses', () => {
    expect(validateTestCommand('(npm test)').valid).toBe(false);
  });

  it('rejects redirects', () => {
    expect(validateTestCommand('npm test > /dev/null').valid).toBe(false);
    expect(validateTestCommand('npm test < input.txt').valid).toBe(false);
  });

  it('rejects newlines', () => {
    expect(validateTestCommand('npm test\nrm -rf /').valid).toBe(false);
  });

  it('rejects carriage returns', () => {
    expect(validateTestCommand('npm test\rrm -rf /').valid).toBe(false);
  });

  it('rejects null bytes', () => {
    expect(validateTestCommand('npm test\0whoami').valid).toBe(false);
  });

  // --- Empty / whitespace / nullish ---
  it('rejects empty string', () => {
    const result = validateTestCommand('');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it('rejects whitespace-only', () => {
    const result = validateTestCommand('   ');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it('rejects null and undefined', () => {
    expect(validateTestCommand(null).valid).toBe(false);
    expect(validateTestCommand(undefined).valid).toBe(false);
  });
});

// =============================================================================
// detectTestFramework
// =============================================================================
describe('detectTestFramework', () => {
  it('detects npm test from package.json with scripts.test', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'npm test', description: 'npm test → jest' });
  });

  it('falls through when package.json has "no test specified"', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const result = detectTestFramework(dir);
    expect(result).toBeNull();
  });

  it('detects pytest from pytest.ini', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'pytest.ini'), '');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'pytest -v', description: 'pytest -v' });
  });

  it('detects pytest from conftest.py', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'conftest.py'), '');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'pytest -v', description: 'pytest -v' });
  });

  it('detects pytest from pyproject.toml with [tool.pytest]', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-v"');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'pytest -v', description: 'pytest -v' });
  });

  it('does not detect pytest from pyproject.toml without pytest config', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[build-system]\nrequires = ["setuptools"]');
    const result = detectTestFramework(dir);
    expect(result).toBeNull();
  });

  it('detects cargo test from Cargo.toml', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'cargo test', description: 'cargo test' });
  });

  it('detects go test from go.mod', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\ngo 1.21');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'go test ./...', description: 'go test ./...' });
  });

  it('detects make test from Makefile with test target', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo running');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'make test', description: 'make test' });
  });

  it('does not detect make test from Makefile without test target', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'Makefile'), 'build:\n\techo building');
    const result = detectTestFramework(dir);
    expect(result).toBeNull();
  });

  it('returns null for empty directory', () => {
    const dir = makeTempDir();
    const result = detectTestFramework(dir);
    expect(result).toBeNull();
  });

  it('prefers npm test over Cargo.toml (priority chain)', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"');
    const result = detectTestFramework(dir);
    expect(result.command).toBe('npm test');
  });

  it('falls through to Cargo.toml when package.json has no test specified', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"');
    const result = detectTestFramework(dir);
    expect(result).toEqual({ command: 'cargo test', description: 'cargo test' });
  });
});

// =============================================================================
// extractSummary
// =============================================================================
describe('extractSummary', () => {
  it('extracts Jest passed summary', () => {
    const output = 'PASS src/test.js\nTests:  3 passed, 3 total\nTime:  1.2s';
    expect(extractSummary(output, true)).toBe('Tests:  3 passed, 3 total');
  });

  it('extracts Jest failure summary', () => {
    const output = 'FAIL src/test.js\nTests:  1 failed, 2 passed, 3 total';
    expect(extractSummary(output, false)).toBe('Tests:  1 failed, 2 passed, 3 total');
  });

  it('extracts pytest passed summary', () => {
    const output = 'test_foo.py ..\n======= 2 passed in 0.03s =======';
    expect(extractSummary(output, true)).toBe('======= 2 passed in 0.03s =======');
  });

  it('extracts pytest failure summary', () => {
    const output = 'test_foo.py .F\n======= 1 failed, 1 passed in 0.05s =======';
    expect(extractSummary(output, false)).toBe('======= 1 failed, 1 passed in 0.05s =======');
  });

  it('extracts cargo test passed summary', () => {
    const output = 'running 3 tests\ntest foo ... ok\ntest result: ok. 3 passed; 0 failed';
    expect(extractSummary(output, true)).toBe('test result: ok. 3 passed; 0 failed');
  });

  it('extracts cargo test failure summary', () => {
    const output = 'running 2 tests\ntest foo ... FAILED\ntest result: FAILED. 0 passed; 1 failed';
    expect(extractSummary(output, false)).toBe('test result: FAILED. 0 passed; 1 failed');
  });

  it('extracts go test ok summary', () => {
    const output = 'ok  \texample.com/pkg\t0.003s';
    expect(extractSummary(output, true)).toBe('ok  \texample.com/pkg\t0.003s');
  });

  it('extracts go test FAIL summary', () => {
    const output = '--- FAIL: TestFoo (0.00s)\nFAIL\texample.com/pkg\t0.004s';
    expect(extractSummary(output, false)).toBe('FAIL\texample.com/pkg\t0.004s');
  });

  it('falls back to last line when no framework pattern matches', () => {
    const output = 'Running custom tests...\nAll good!';
    expect(extractSummary(output, true)).toBe('All good!');
  });

  it('returns default message for empty output when passed=true', () => {
    expect(extractSummary('', true)).toBe('Tests passed');
  });

  it('returns default message for empty output when passed=false', () => {
    expect(extractSummary('', false)).toBe('Tests failed');
  });
});
