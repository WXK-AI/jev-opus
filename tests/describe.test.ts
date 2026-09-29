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

test('a passing summary does not vouch for a script that ran after it, or a runner that failed', async () => {
  const { summarizeToolCall } = await import('../src/claude/describe.ts');
  const { emptyCore, reduceBatch } = await import('../src/router/state.ts');
  const header = '> p@1.0.0 test\n> node --test\n\n';
  const posttest = `${header}# pass 1\n# fail 0\n\n> p@1.0.0 posttest\n> node validate.js\n\nError: validation failed\n`;
  const hook = bash('npm test | tail', posttest);
  assert.deepEqual([hook.failed, hook.suspect, hook.evidence], [false, true, 'Error: validation failed']);
  // It neither clears the open issue nor passes as a clean run.
  const call = (text: string) => summarizeToolCall('Bash', { command: 'npm test | tail' }, text, false);
  const open = reduceBatch(emptyCore(), [call('not ok 1 - dates\n# pass 0\n# fail 1\n')], 'medium').state;
  assert.equal(reduceBatch(open, [call(posttest)], 'high').state.issues.length, 1);
  assert.equal(reduceBatch(open, [call(`${header}# pass 1\n# fail 0\n`)], 'high').state.issues.length, 0);
  // Verdict lines from the hook, or the runner reporting failure, fail the command.
  assert.equal(bash('npm test | tail', `${header}# pass 1\n# fail 0\n\n> p@1.0.0 posttest\n> eslint .\n\n✖ 2 problems\n`).failed, true);
  assert.equal(bash('make check | tail', '# pass 3\n# fail 0\nsrc/a.py:1:1: E302\nmake: *** [lint] Error 1\n').failed, true);
  assert.equal(bash('yarn test | tail', '$ node --test\n# pass 3\n# fail 0\n$ node validate.js\nerror Command failed with exit code 1.\n').failed, true);
  const strong = bash('npm test | tail', `${header}# pass 1\n# fail 0\nnpm error code ELIFECYCLE\nnpm error Lifecycle script \`posttest\` failed`);
  assert.deepEqual([strong.failed, strong.cause], [true, 'check-output']);
  // Hooks before the check, or a clean hook after it, leave a passing run passing.
  assert.equal(bash('npm test | tail', `> p@1.0.0 pretest\n> tsc\n\n${header}Error: expected log line\n# pass 1\n# fail 0\n`).failed, false);
  assert.equal(bash('npm test | tail', `Error: logged by a passing test\n${header}# pass 1\n# fail 0\n`).failed, false, 'text before the summary is still outranked by it');
  assert.equal(bash('npm test | tail', `Error: logged by a passing test\n${header}# pass 1\n# fail 0\n`).suspect, false);
  assert.equal(bash('npm test | tail', `${header}# pass 1\n# fail 0\n\n> p@1.0.0 posttest\n> node validate.js\n\nok\n`).suspect, false);
});

test('git diff --check is a validation, not a lookup', async () => {
  const { summarizeToolCall } = await import('../src/claude/describe.ts');
  const { emptyCore, reduceBatch } = await import('../src/router/state.ts');
  for (const command of ['git diff --check', 'git diff --cached --check -- src', 'git -C repo diff HEAD~1 --check', 'git diff-index --check --cached HEAD', 'git show --check', 'git log --check -1']) {
    assert.equal(commandKind(command), 'check', command);
  }
  assert.equal(commandKind('git diff --exit-code'), 'compare');
  assert.equal(commandKind('git diff HEAD~1'), 'lookup');
  assert.equal(commandKind('git status --check'), 'lookup');
  assert.equal(commandKind('git diff -- --check'), 'lookup');
  const whitespace = 'f.ts:1: trailing whitespace.\n+a \nf.ts:3: leftover conflict marker\n';
  const failed = summarizeToolCall('Bash', { command: 'git diff --check' }, `Exit code 2\n${whitespace}`, true);
  assert.equal(reduceBatch(emptyCore(), [failed], 'medium').state.issues.length, 1);
  // A masked exit status still leaves git's own report.
  assert.equal(bash('git diff --check; npm test | tail', `${whitespace}# pass 3\n# fail 0\n`).failed, true);
  assert.equal(bash('git diff --check', '').failed, false);
});

test('heredoc operators inside quotes, comments, and arithmetic are text, not heredocs', async () => {
  const { testRunner } = await import('../src/claude/describe.ts');
  const npm = testRunner('Bash', { command: 'npm test' });
  for (const head of [
    "printf '%s\\n' 'cat <<EOF'",
    'echo "run <<EOF first"',
    "echo $'it\\'s <<EOF'",
    'echo hi # see <<EOF',
    'echo $((1<<3))',
    '(( x = 1 << 3 ))',
    'cat <<<"x"',
    'echo "<<EOF"',
    "printf '<<EOF\\n'",
    'echo "a\n<<EOF\nb"',
  ]) {
    const command = `${head}\nnpm test 2>&1 | tail`;
    assert.ok(shellSegments(command).includes('npm test 2>&1'), command);
    const call = bash(command, '# pass 2\n# fail 1\n');
    assert.deepEqual([call.kind, call.failed], ['check', true], command);
    if (!/[$()]/.test(head)) assert.equal(testRunner('Bash', { command }), npm, head);
  }
  assert.equal(bash('echo "<<EOF"\nnpm test | tail', '<<EOF\n# tests 1\n# pass 0\n# fail 1\n').failed, true);
  // Real heredocs still drop their bodies: in `$(…)` inside quotes, several per line, `<<-`.
  assert.deepEqual(shellSegments("git commit -m \"$(cat <<'EOF'\nfix: npm test; pytest\nEOF\n)\" && git log -1"), ['cat', 'git commit -m "$()"', 'git log -1']);
  assert.equal(commandKind("git commit -m \"$(cat <<'EOF'\ndon't fail; npm test\nEOF\n)\""), 'quiet');
  assert.equal(commandKind("cat <<'EOF' > a.txt\nnpm test\nEOF\nls"), 'lookup');
  assert.equal(commandKind("echo 'x' <<EOF\nnpm test\nEOF\nls"), 'lookup');
  assert.equal(testRunner('Bash', { command: "cat > a <<'EOF'\nnpm test\nEOF\nnpm test" }), npm);
  assert.deepEqual(shellSegments('cat <<A <<B\nnpm test\nA\npytest\nB\nls'), ['cat', 'ls']);
  assert.deepEqual(shellSegments('cat <<-EOF\n\tpytest\n\tEOF\nls'), ['cat', 'ls']);
  // A body ends only at its exact delimiter line.
  assert.deepEqual(shellSegments('cat <<EOF\n  EOF\npytest\nEOF\nls'), ['cat', 'ls']);
});
