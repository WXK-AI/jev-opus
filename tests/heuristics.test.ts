import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heuristicStepSignals, heuristicTaskProfile } from '../src/router/heuristics.ts';
import type { StepContext, ToolCallSummary } from '../src/router/types.ts';

test('task heuristics classify common requests', () => {
  assert.equal(heuristicTaskProfile('hi!').taskType, 'chat');
  assert.equal(heuristicTaskProfile('The login test is failing with a TypeError, please fix it').taskType, 'debugging');
  assert.equal(heuristicTaskProfile('Design the architecture for a multi-region event bus and discuss trade-offs').taskType, 'architecture');
  assert.equal(heuristicTaskProfile('Implement a new /export endpoint that streams CSV').taskType, 'code_feature');
  assert.equal(heuristicTaskProfile('Refactor the payment module into smaller files').taskType, 'refactor');
});

test('task heuristics: hard words raise difficulty, risky words raise stakes', () => {
  const plain = heuristicTaskProfile('Implement a new feature that adds a settings page');
  const hard = heuristicTaskProfile('Implement a lock-free concurrent queue and fix the race condition under production load');
  assert.ok(hard.difficulty > plain.difficulty);
  assert.ok(hard.stakes > plain.stakes);
});

const ctx = (lastBatch: ToolCallSummary[], consecutiveFailures = 0): StepContext => ({
  prompt: 'fix the bug',
  profile: heuristicTaskProfile('fix the bug'),
  turn: 1,
  current: 'medium',
  consecutiveFailures,
  assistantNote: '',
  lastBatch,
  trajectory: [],
});
const call = (tool: string, summary: string, failed = false): ToolCallSummary => ({ tool, summary, failed, result: '' });

test('step heuristics derive the phase from the tool batch', () => {
  assert.equal(heuristicStepSignals(ctx([call('Read', 'a.ts'), call('Grep', '"x"')])).phase, 'exploring');
  assert.equal(heuristicStepSignals(ctx([call('Edit', 'a.ts')])).phase, 'implementing');
  assert.equal(heuristicStepSignals(ctx([call('Bash', 'npm test')])).phase, 'verifying');
  assert.equal(heuristicStepSignals(ctx([call('Bash', 'npm test', true)], 1)).phase, 'diagnosing');
});

test('step heuristics flag stuck after repeated failures', () => {
  assert.ok(heuristicStepSignals(ctx([call('Bash', 'npm test', true)], 3)).stuck >= 0.7);
});

test('step heuristics mark ambiguous batches as low confidence', () => {
  assert.ok(heuristicStepSignals(ctx([])).phaseConfidence < 0.5, 'empty batch: no evidence the work is finishing');
  const mixed = heuristicStepSignals(ctx([call('Edit', 'a.ts'), call('Bash', 'npm test')]));
  assert.ok(mixed.phaseConfidence < 0.5, 'write + verify in one batch is ambiguous');
});

test('step heuristics ignore environment-only failures when asked', () => {
  const down = ctx([call('Bash', 'npm install', true)], 4);
  assert.equal(heuristicStepSignals(down).phase, 'diagnosing');
  const env = heuristicStepSignals(down, { ignoreFailures: true });
  assert.notEqual(env.phase, 'diagnosing');
  assert.ok(env.stuck < 0.7, 'environment blockers are not being stuck');
});
