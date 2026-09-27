import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('CLI rejects invalid operational options before starting a task', () => {
  const invalid: Array<[string[], RegExp]> = [
    [['--permission-mode', 'unsafe'], /--permission-mode must be one of/],
    [['--yolo', '--permission-mode', 'unsafe'], /--permission-mode must be one of/],
    [['--settings', 'project,unknown'], /--settings must be a comma-separated list/],
    [['--settings', 'project,project'], /--settings must be a comma-separated list/],
    [['--max-turns', '0'], /--max-turns must be an integer/],
    [['--max-turns', '1.5'], /--max-turns must be an integer/],
    [['--port', '65536'], /--port must be an integer/],
    [['--min', 'high', '--max', 'low'], /--min cannot be higher than --max/],
  ];
  for (const [args, expected] of invalid) {
    const result = spawnSync(process.execPath, ['src/cli.ts', '--no-jev', '--route-only', ...args, 'fix a test'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `args: ${args.join(' ')}`);
    assert.match(result.stderr, expected);
  }
});
