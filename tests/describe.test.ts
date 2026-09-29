import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyToolResult, commandKind, describeToolInput, shellSegments } from '../src/claude/describe.ts';

const bash = (command: string, stdout: string, isError = false) => classifyToolResult('Bash', { command }, stdout, isError);

test('a check whose output reports failures fails, even when a pipeline masked the exit status', () => {
  assert.equal(bash('npm test 2>&1 | tail -5', '# tests 3\n# pass 0\n# fail 3\n').failed, true);
  assert.equal(bash('node --test', '✖ leap years (1.2ms)\n').failed, true);
  assert.equal(bash('npx jest | tail', 'Tests: 2 failed, 5 passed').failed, true);
  assert.equal(bash('npm test | tail', 'bash: npm: command not found').failed, true);
  assert.equal(classifyToolResult('Bash', { command: 'make' }, '', false, { stdout: '', stderr: '', exitCode: 2 }).failed, true);
  assert.equal(classifyToolResult('Bash', { command: 'ls' }, '', false, { stdout: '', interrupted: true }).cause, 'interrupted');
  assert.equal(bash('npm test', 'Exit code 1\nboom', true).cause, 'tool-error');
});

test('passing checks and non-checks leave output text alone', () => {
  assert.equal(bash('npm test', '# tests 3\n# pass 3\n# fail 0\n').failed, false);
  assert.equal(bash('npx jest', 'Tests: 0 failed, 7 passed').failed, false);
  assert.equal(classifyToolResult('Read', { file_path: 'a.ts' }, 'Error: this is just file content', false).failed, false);
  assert.equal(bash('cat src/checks.ts', 'const FAIL = /FAILED|FAIL/;\nFAIL\n').failed, false);
  const suspect = bash('python3 analyze.py runs/', 'FAILED tests/test_x.py::test_y');
  assert.deepEqual([suspect.failed, suspect.suspect, suspect.cause], [false, true, 'output-text']);
});

test('commands are classified from every simple command, not the clipped summary', () => {
  assert.equal(commandKind('cd /repo; B=$(cat .base); git diff $B -- src'), 'lookup');
  assert.equal(commandKind("sysctl -n hw.ncpu | awk '{print $1}'; docker info --format '{{.NCPU}}'; uptime; sed -n 1,80p a.py"), 'lookup');
  assert.equal(commandKind("cd /r && python3 - <<'P'\nprint('npm test')\nP\nhead -1 a.ts; npx tsc --noEmit -p . && npm test 2>&1 | grep -E '^# (pass|fail)'"), 'check');
  assert.equal(commandKind('git add a && git commit -q -m "x; npm test" && git log --oneline -1'), 'quiet');
  assert.equal(commandKind("sed -i '' 's/a/b/' x.js"), 'quiet');
  assert.equal(commandKind('echo "$(pytest | tail)"'), 'check');
  assert.equal(commandKind('FOO=1 uv run pytest -q'), 'check');
  assert.equal(commandKind('bash -c "cat a && npm run test:unit"'), 'check');
  assert.equal(commandKind('./scripts/run-tests.sh'), 'check');
  assert.equal(commandKind('for d in a b; do tail -3 $d/log.txt; done'), 'lookup');
  assert.equal(commandKind('python3 trace.py runs/x | tail -20'), 'other');
  assert.deepEqual(shellSegments('npm test 2>&1 | tail -3 # note'), ['npm test 2>&1', 'tail -3']);
});

test('describeToolInput renders the useful part of each tool input', () => {
  assert.equal(describeToolInput('Bash', { command: 'npm   test' }), 'npm test');
  assert.equal(describeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x' }), 'src/a.ts');
  assert.equal(describeToolInput('Grep', { pattern: 'TODO', path: 'src' }), '"TODO" in src');
});

test('testRunner reads the suite from the full command, preserves suite scope and rejects ambiguous multiple checks', async () => {
  const { testRunner } = await import('../src/claude/describe.ts');
  const heredoc = `cat > package.json <<'EOF'\n${'{"x":1}\n'.repeat(40)}EOF\ncat > dates.test.js <<'EOF'\n...\nEOF\nnpm test 2>&1 | tail -30`;
  assert.equal(testRunner('Bash', { command: heredoc }), testRunner('Bash', { command: 'npm test' }), 'found even far past the 160-char summary');
  assert.equal(testRunner('Bash', { command: "sed -i '' 's/a/b/' dates.js && npm test" }), testRunner('Bash', { command: 'npm test' }));
  assert.equal(testRunner('Bash', { command: 'npx tsc --noEmit && pytest -q' }), undefined);
  assert.equal(testRunner('Bash', { command: 'ls -la' }), undefined);
  assert.equal(testRunner('Read', { file_path: 'npm test' }), undefined);
});

test('check identities preserve package, target, case, and check type', async () => {
  const { testRunner } = await import('../src/claude/describe.ts');
  const { emptyCore, reduceBatch } = await import('../src/router/state.ts');
  const call = (command: string, failed: boolean) => ({ tool: 'Bash', summary: describeToolInput('Bash', { command }), runner: testRunner('Bash', { command }), failed, result: failed ? 'FAIL assertion' : 'PASS' });
  for (const [failed, unrelated] of [
    ['cd api && npm test', 'cd web && npm test'],
    ['npm test', 'npm test -- dates.test.js'],
    ['pytest Tests/A.py', 'pytest Tests/a.py'],
    ['cargo test', 'cargo check'],
    ['npm test --workspace api', 'npm test --workspace web'],
  ]) {
    const state = reduceBatch(emptyCore(), [call(failed, true)], 'medium').state;
    const other = reduceBatch(state, [call(unrelated, false)], 'high');
    assert.equal(other.state.issues.length, 1, `${unrelated} must not resolve ${failed}`);
    assert.equal(reduceBatch(other.state, [call(failed, false)], 'high').state.issues.length, 0);
  }
});
