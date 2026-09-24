import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeToolInput, looksFailed } from '../src/claude/describe.ts';

test('looksFailed catches common test-runner failure output', () => {
  assert.equal(looksFailed('Bash', { stdout: '# tests 3\n# pass 0\n# fail 3\n', stderr: '' }), true);
  assert.equal(looksFailed('Bash', { stdout: '✖ leap years (1.2ms)\n', stderr: '' }), true);
  assert.equal(looksFailed('Bash', { stdout: 'Tests: 2 failed, 5 passed', stderr: '' }), true);
  assert.equal(looksFailed('Bash', { stdout: '', stderr: 'zsh: command not found: foo' }), true);
  assert.equal(looksFailed('Bash', { stdout: '', stderr: '', exitCode: 2 }), true);
});

test('looksFailed leaves passing output alone', () => {
  assert.equal(looksFailed('Bash', { stdout: '# tests 3\n# pass 3\n# fail 0\n', stderr: '' }), false);
  assert.equal(looksFailed('Bash', { stdout: 'Tests: 0 failed, 7 passed', stderr: '' }), false);
  assert.equal(looksFailed('Read', 'Error: this is just file content'), false);
});

test('describeToolInput renders the useful part of each tool input', () => {
  assert.equal(describeToolInput('Bash', { command: 'npm   test' }), 'npm test');
  assert.equal(describeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x' }), 'src/a.ts');
  assert.equal(describeToolInput('Grep', { pattern: 'TODO', path: 'src' }), '"TODO" in src');
});

test('testRunner reads the suite from the full command, last runner wins', async () => {
  const { testRunner } = await import('../src/claude/describe.ts');
  const heredoc = `cat > package.json <<'EOF'\n${'{"x":1}\n'.repeat(40)}EOF\ncat > dates.test.js <<'EOF'\n...\nEOF\nnpm test 2>&1 | tail -30`;
  assert.equal(testRunner('Bash', { command: heredoc }), 'npm test', 'found even far past the 160-char summary');
  assert.equal(testRunner('Bash', { command: "sed -i '' 's/a/b/' dates.js && npm test" }), 'npm test');
  assert.equal(testRunner('Bash', { command: 'npx tsc --noEmit && pytest -q' }), 'pytest');
  assert.equal(testRunner('Bash', { command: 'ls -la' }), undefined);
  assert.equal(testRunner('Read', { file_path: 'npm test' }), undefined);
});
