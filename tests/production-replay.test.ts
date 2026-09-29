import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { rank, type Effort } from '../src/effort.ts';
import { lastToolRound, type Message } from '../src/gateway/transcript.ts';
import { EffortRouter } from '../src/router/router.ts';
import { isEnvironmentFailure } from '../src/router/state.ts';
import type { EffortDecision, TaskProfile, ToolCallSummary } from '../src/router/types.ts';

/**
 * Offline replay of tool results observed in a production session
 * (docs/production-session-review-2026-09-28.md): successful reads of source,
 * diffs, and logs that mention failures must not open unresolved issues that
 * hold effort high, while genuinely failing checks — including ones a
 * pipeline masked — still must.
 */

interface Case { case: string; command: string; output: string; isError?: boolean; environment?: boolean }
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/production-tool-results.json', import.meta.url), 'utf8')) as {
  falseFailures: Case[]; suspectOnly: Case[]; genuineFailures: Case[];
};

const PROFILE: TaskProfile = { taskType: 'code_feature', typeConfidence: 0.5, difficulty: 1.8, stakes: 0.2, source: 'heuristic' };
let ids = 0;

/** The gateway's view of one tool round, built from the same message shapes Claude Code sends. */
function round(command: string, output: string, isError = false): ToolCallSummary[] {
  const id = `toolu_${String(++ids).padStart(4, '0')}`;
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'improve the checks' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] },
  ];
  return lastToolRound(messages).batch;
}

const PASSING_SUITE = (): ToolCallSummary[] => round('npm test 2>&1 | tail -4', '# tests 130\n# pass 130\n# fail 0\n');
const OTHER_PASSING_SUITE = (): ToolCallSummary[] => round('cd api && npm test 2>&1 | tail -4', '# tests 12\n# pass 12\n# fail 0\n');

async function stepper(start: Effort = 'medium') {
  const router = new EffortRouter({ jev: null, bounds: { min: 'low', max: 'max' } });
  await router.routeTask('improve the failure checks in the runtime package', null);
  let current = start, turn = 0;
  const decisions: EffortDecision[] = [];
  return {
    router, decisions,
    async step(batch: ToolCallSummary[]): Promise<EffortDecision> {
      const d = await router.routeStep({
        prompt: 'improve the failure checks', profile: PROFILE, turn: ++turn, current,
        consecutiveFailures: batch.some((c) => c.failed) ? 1 : 0, assistantNote: '', lastBatch: batch, trajectory: [],
      });
      current = d.effort;
      decisions.push(d);
      return d;
    },
  };
}

test('production false alarms: successful source, diff, and history reads are not failures', () => {
  for (const c of fixtures.falseFailures) {
    const [call] = round(c.command, c.output, c.isError);
    assert.equal(call!.failed, false, c.case);
    assert.equal(call!.suspect, undefined, `${c.case} is not even suspect`);
  }
});

test('production: failure text from non-check scripts is suspect evidence, never a failure', () => {
  for (const c of fixtures.suspectOnly) {
    const [call] = round(c.command, c.output, c.isError);
    assert.equal(call!.failed, false, c.case);
    assert.equal(call!.suspect, true, c.case);
    assert.equal(call!.cause, 'output-text', c.case);
  }
});

test('production: genuinely failing checks still fail when a pipeline masks the exit status', () => {
  for (const c of fixtures.genuineFailures) {
    const [call] = round(c.command, c.output, c.isError);
    assert.equal(call!.failed, true, c.case);
    assert.equal(call!.kind, 'check', c.case);
    assert.equal(isEnvironmentFailure(call!), c.environment === true, `${c.case}: environment classification`);
    assert.ok(call!.result.length > 0 && call!.result.length <= 700, `${c.case}: evidence is the detected lines`);
  }
});

test('production replay: the review reproduction no longer escalates or holds', async () => {
  const s = await stepper('medium');
  const diff = fixtures.falseFailures[1]!;
  const first = await s.step(round(diff.command, diff.output));
  assert.ok(rank(first.effort) <= rank('medium'), `a successful git diff is not a failing check: ${first.reasons.join('; ')}`);
  assert.doesNotMatch(first.reasons.join('; '), /failing checks/);
  const next = await s.step(PASSING_SUITE());
  assert.doesNotMatch(next.reasons.join('; '), /unresolved/);
  assert.deepEqual(next.evidence?.open, []);
});

test('production replay: a long session of false alarms never leaves an open issue', async () => {
  const s = await stepper('high');
  const all = [...fixtures.falseFailures, ...fixtures.suspectOnly];
  for (let i = 0; i < 40; i++) {
    const c = all[i % all.length]!;
    const d = await s.step(i % 5 === 4 ? PASSING_SUITE() : round(c.command, c.output));
    assert.deepEqual(d.evidence?.open, [], `step ${i + 1} (${c.case})`);
    assert.doesNotMatch(d.reasons.join('; '), /unresolved/, `step ${i + 1}`);
  }
  assert.ok(s.decisions.some((d) => d.effort !== 'high'), 'effort is free to come down from high');
});

test('production replay: a genuine failure stays open through an unrelated passing suite, then clears', async () => {
  const s = await stepper('medium');
  const failing = fixtures.genuineFailures[1]!; // npm test … `# fail 1`
  const [failed] = round(failing.command, failing.output);
  const d1 = await s.step([failed!]);
  assert.equal(d1.effort, 'high', d1.reasons.join('; '));
  assert.equal(d1.evidence!.open.length, 1);
  const issue = d1.evidence!.open[0]!;
  assert.equal(issue.toolId, failed!.id, 'the audit names the originating tool call');
  assert.equal(issue.cause, 'check-summary');
  assert.equal(issue.clears, 'command-succeeds', 'two checks in one command have no single suite identity');
  assert.deepEqual(d1.evidence!.observed, [{ toolId: failed!.id, tool: 'Bash', kind: 'check', cause: 'check-summary', outcome: 'failed' }]);

  const d2 = await s.step(OTHER_PASSING_SUITE());
  assert.equal(d2.evidence!.open.length, 1, 'a different suite passing does not clear it');
  assert.equal(d2.evidence!.open[0]!.age, 1);
  assert.match(d2.reasons.join('; '), /unresolved|holding/);

  const fixed = round('cd /repo/agents/clause-fg/packages/runtime && npx tsc --noEmit -p . && npm test 2>&1 | grep -E "^# (pass|fail|skip)|not ok" | head', '# pass 130\n# fail 0\n');
  const d3 = await s.step(fixed);
  assert.deepEqual(d3.evidence!.open, [], 'the same suite passing resolves it');
});

test('production replay: router snapshots keep issue provenance across a restart', async () => {
  const s = await stepper('medium');
  const failing = fixtures.genuineFailures[0]!;
  const [failed] = round(failing.command, failing.output);
  await s.step([failed!]);
  const snapshot = JSON.parse(JSON.stringify(s.router.snapshot()));
  assert.doesNotMatch(JSON.stringify(snapshot), /test_single_run|summarize/, 'no command or output text is persisted');
  const restored = new EffortRouter({ jev: null, bounds: { min: 'low', max: 'max' } });
  restored.restore(snapshot);
  const d = await restored.routeStep({
    prompt: 'x', profile: PROFILE, turn: 2, current: 'high', consecutiveFailures: 0, assistantNote: '', lastBatch: OTHER_PASSING_SUITE(), trajectory: [],
  });
  assert.equal(d.evidence!.open[0]!.toolId, failed!.id);
  assert.equal(d.evidence!.open[0]!.cause, 'check-output');
});

/* ---------- attribution counterexamples (docs/classifier-implementation-review-2026-09-28.md) ---------- */

const TSC_ERROR = 'src/index.ts(1,1): error TS2304: Cannot find name foo.';

test('a passing test summary does not hide a failing compiler in the same command, in either order', () => {
  for (const command of ['npm test; npx tsc --noEmit 2>&1 | tail -5', 'npx tsc --noEmit 2>&1 | tail -5; npm test']) {
    const output = command.startsWith('npm') ? `# pass 149\n# fail 0\n${TSC_ERROR}\n` : `${TSC_ERROR}\n# pass 149\n# fail 0\n`;
    const [call] = round(command, output);
    assert.equal(call!.failed, true, command);
    assert.equal(call!.cause, 'check-output', command);
    assert.match(call!.result, /error TS2304/, command);
  }
  // A lone check's own passing summary still outranks stray text.
  assert.equal(round('npm test 2>&1 | tail -5', `Error: expected log line\n# pass 3\n# fail 0\n`)[0]!.failed, false);
  // Beside another check, weak markers (no verdict line) conflict with the summary: suspect, not failed.
  const [weak] = round('npm test; python3 -m mypy src | tail', 'Traceback (most recent call last)\n# pass 3\n# fail 0\n');
  assert.deepEqual([weak!.failed, weak!.suspect], [false, true]);
});

test('passing tests beside a still-failing compiler do not resolve the open issue', async () => {
  const s = await stepper('medium');
  const command = 'npm test; npx tsc --noEmit 2>&1 | tail -5';
  const d1 = await s.step(round(command, `not ok 1 - dates\n# pass 148\n# fail 1\n${TSC_ERROR}\n`));
  assert.equal(d1.evidence!.open.length, 1);
  const d2 = await s.step(round(command, `# pass 149\n# fail 0\n${TSC_ERROR}\n`));
  assert.ok(d2.evidence!.open.length >= 1, 'the compiler failure keeps an issue open');
  assert.doesNotMatch(d2.reasons.join('; '), /now passes/);
  const d3 = await s.step(round(command, '# pass 149\n# fail 0\n'));
  assert.deepEqual(d3.evidence!.open, [], 'both passing clears it');
});

test('failure text from a file read beside a silent check is suspect, not a failed check', () => {
  for (const command of ['cat previous-test.log; npx tsc --noEmit', "sed -n '1,40p' previous-test.log; ./scripts/check.sh", 'git show HEAD:test.log && npm run lint', 'docker logs api | tail; npm test']) {
    const [call] = round(command, 'FAIL src/date.test.ts\n  ● dates › leap years\n');
    assert.equal(call!.kind, 'check', command);
    assert.deepEqual([call!.failed, call!.suspect], [false, true], command);
  }
  // A failing summary is a runner's format that source reads don't produce, so it still counts…
  const [source] = round('grep -n "est_per_cell" test_summarize.py; python3 -m unittest test_summarize 2>&1 | tail -1', '98:  self.assertAlmostEqual(x, y)\nFAILED (failures=1)\n');
  assert.deepEqual([source!.failed, source!.cause], [true, 'check-summary']);
  // …but a log or saved output can hold an old one.
  for (const command of ['cat runs/previous-test.log; npx tsc --noEmit', 'tail -20 /tmp/task.output; npm run lint', 'journalctl -u api | tail; npm test | tail']) {
    const [call] = round(command, 'Tests: 1 failed, 4 passed, 5 total\n');
    assert.deepEqual([call!.failed, call!.suspect], [false, true], command);
  }
  // Reads whose output goes elsewhere or is metadata don't taint a check's output.
  for (const command of ['cat a.log > /tmp/copy; npm test | tail', 'ls -la && echo "== run" && npm test | tail', 'B=$(cat .base); npm test | tail']) {
    assert.equal(round(command, '# pass 2\n# fail 1\n')[0]!.failed, true, command);
  }
});

test('a failed comparison is a failure, not an exploratory lookup', async () => {
  for (const [command, output] of [
    ['cmp expected.txt actual.txt', 'expected.txt actual.txt differ: char 5, line 1'],
    ['diff expected.txt actual.txt', '1c1\n< a\n---\n> b'],
    ['git diff --exit-code -- golden/', 'diff --git a/golden/x b/golden/x'],
    ['cmp expected.txt missing.txt', 'cmp: missing.txt: No such file or directory'],
  ]) {
    const [call] = round(command!, `Exit code 1\n${output}`, true);
    assert.equal(call!.kind, 'compare', command);
    const s = await stepper('medium');
    const d = await s.step([call!]);
    assert.equal(d.evidence!.open.length, 1, `${command} opens an issue`);
    assert.deepEqual(d.evidence!.observed.map((o) => o.outcome), ['failed'], command);
    assert.notEqual(d.effort, 'low', `${command}: no step down on a mismatch`);
  }
  // Displaying a diff that succeeds is still just a read, whatever it shows.
  assert.equal(round('diff -u old.log new.log', ' FAIL src/a.test.ts\n-ok\n+not ok 3')[0]!.failed, false);
});

test('shell wrappers and shell-fed heredocs keep check detection', () => {
  const output = '# pass 3\n# fail 1\n';
  for (const command of [
    "bash -lc 'npm test 2>&1 | tail -5'",
    "bash -c 'npm test 2>&1 | tail -5'",
    "bash -euo pipefail -c 'cd api && npm test 2>&1 | tail -5'",
    "sh -ec 'npm test | tail'",
    "bash <<'EOF'\ncd api\nnpm test 2>&1 | tail -5\nEOF",
    "bash -s <<'EOF' 2>&1 | tail -5\nnpm test\nEOF",
  ]) {
    const [call] = round(command, output);
    assert.equal(call!.kind, 'check', command);
    assert.equal(call!.failed, true, command);
  }
  // A heredoc fed to anything but a shell is data, not commands.
  const written = round("cat > run.sh <<'EOF'\nnpm test\nEOF", output)[0]!;
  assert.deepEqual([written.kind, written.failed, written.suspect], ['lookup', false, undefined]);
  assert.equal(round("python3 - <<'EOF'\nprint('# fail 1')\nEOF", output)[0]!.suspect, true);
  // A shell reading a file inside `-c` taints its output like a top-level read.
  assert.equal(round("bash -lc 'cat old.log; npx tsc --noEmit'", 'FAIL a.test.ts\n')[0]!.suspect, true);
});
