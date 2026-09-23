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
