import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('evaluation dry run pins the ref and makes no agent calls or result file', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-eval-test-'));
  try {
    const manifest = path.join(temp, 'manifest.json');
    const output = path.join(temp, 'results.jsonl');
    fs.writeFileSync(manifest, JSON.stringify({ tasks: [{ id: 'smoke', repository: root, ref: 'HEAD', prompt: 'Fix a bug', verify: ['true'] }] }));
    const result = spawnSync(process.execPath, ['evals/run.ts', manifest, output, '--dry-run'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 tasks × 1 trials × 4 modes = 4 runs/);
    assert.match(result.stdout, /smoke: [0-9a-f]{40,64}/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
