import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank, type Effort } from '../src/effort.ts';
import type { JevLike, JevQuestion } from '../src/jev/client.ts';
import { STEP_SET_VERSION, TASK_SET_VERSION } from '../src/router/questions.ts';
import { EffortRouter, type RouterSnapshot } from '../src/router/router.ts';
import {
  emptyCore, fingerprint, isEnvironmentFailure, reasoningIssues, reduceBatch,
} from '../src/router/state.ts';
import type { JevResponse, StepContext, TaskProfile, ToolCallSummary } from '../src/router/types.ts';
import { POLICY_VERSION } from '../src/router/policy.ts';

/* ---------- fixtures ---------- */

const bash = (summary: string, failed = false, result = ''): ToolCallSummary => ({ tool: 'Bash', summary, failed, result });
const fail = (summary: string, result: string): ToolCallSummary => bash(summary, true, result);
const read = (path = 'src/a.ts'): ToolCallSummary => ({ tool: 'Read', summary: path, failed: false, result: 'file contents' });
const edit = (path = 'src/a.ts'): ToolCallSummary => ({ tool: 'Edit', summary: path, failed: false, result: 'applied' });

const PROFILE: TaskProfile = { taskType: 'code_feature', typeConfidence: 0.5, difficulty: 1.8, stakes: 0.2, source: 'heuristic' };

/** A step context as the adapters build it: `current` is the effort in force during the batch. */
const step = (lastBatch: ToolCallSummary[], current: Effort, over: Partial<StepContext> = {}): StepContext => ({
  prompt: 'implement the feature', profile: PROFILE, turn: 1, current,
  consecutiveFailures: lastBatch.some((c) => c.failed) ? 1 : 0,
  assistantNote: '', lastBatch, trajectory: [], ...over,
});

type Answer = Record<string, unknown>;
type AskResponse = { answers?: Record<string, unknown>; signals?: Record<string, 'valid' | 'missing' | 'invalid'>; circuitOpen?: boolean };

/** Scriptable Jev stub speaking the validating-client contract (absent answers + signals map). */
function stubJev(handler: (state: string, questions: Record<string, JevQuestion>) => AskResponse | 'fail' | null) {
  const calls: string[] = [];
  const jev: JevLike & { calls: string[] } = {
    enabled: true,
    calls,
    async ask(state: string, questions: Record<string, JevQuestion>) {
      calls.push(state);
      const r = handler(state, questions);
      if (r === 'fail' || r === null) {
        return { answers: {}, failed: true, error: 'jev down', latencyMs: 1, inputTokens: 0 };
      }
      const res: JevResponse = {
        answers: (r.answers ?? {}) as JevResponse['answers'],
        failed: false, latencyMs: 1, inputTokens: 0,
      };
      if (r.signals) res.signals = r.signals;
      if (r.circuitOpen) res.circuitOpen = true;
      return res;
    },
  };
  return jev;
}

const choice = (value: string, confidence = 0.9): Answer => ({ kind: 'choice', choice: value, confidence, probabilities: {} });
const score = (n: number, confidence = 0.9): Answer => ({ kind: 'score', score: n, confidence, probabilities: {} });
const noul = (p: number): Answer => ({ kind: 'noul', p });
const allValid = (names: string[]) => Object.fromEntries(names.map((n) => [n, 'valid' as const]));

const issues = (r: EffortRouter) => {
  const s = r.snapshot().state as { issues: Array<{ environment: boolean; attempts: number; tried: Effort[] }> };
  return s.issues;
};

const lowTask = (jev: JevLike | null = null) => new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });

/* ---------- reducer ---------- */

test('reducer: failure fingerprints ignore numbers, paths, and timestamps', () => {
  const a = fingerprint(fail('npm test', 'FAIL src/foo/bar.test.ts:12:4 expected 3, got 4 at 12:03:44'));
  const b = fingerprint(fail('npm test', 'FAIL other/dir/x.test.ts:99:1 expected 8, got 9 at 23:59:01'));
  assert.equal(a, b);
  assert.notEqual(fingerprint(fail('npm test', 'a different error')), a);
});

test('reducer: a successful unrelated call does not clear an issue; the same command passing does', () => {
  let s = emptyCore();
  const t = (batch: ToolCallSummary[]) => { const r = reduceBatch(s, batch, 'medium'); s = r.state; return r.outcome; };
  t([fail('npm test', 'AssertionError: expected true')]);
  assert.equal(s.issues.length, 1);
  t([read(), edit(), bash('npm run lint')]);
  assert.equal(s.issues.length, 1, 'unrelated successes keep the issue open');
  const out = t([bash('npm test')]);
  assert.equal(s.issues.length, 0, 'the same command passing clears it');
  assert.equal(out.progress, 'resolved');
});

test('reducer: same command failing with a different error is a new issue', () => {
  let s = emptyCore();
  const t = (batch: ToolCallSummary[]) => { s = reduceBatch(s, batch, 'medium').state; };
  t([fail('npm test', 'AssertionError A')]);
  t([fail('npm test', 'TypeError B')]);
  assert.equal(s.issues.length, 2);
  t([bash('npm test')]);
  assert.equal(s.issues.length, 0, 'a pass clears every issue for that command');
});

test('reducer: attempts and tried efforts accumulate per issue', () => {
  let s = emptyCore();
  for (const e of ['low', 'medium', 'medium', 'high'] as const) {
    s = reduceBatch(s, [fail('npm test', 'AssertionError')], e).state;
  }
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0]!.attempts, 4);
  assert.deepEqual(s.issues[0]!.tried, ['low', 'medium', 'high']);
});

test('reducer: progress classifies the latest batch', () => {
  let s = emptyCore();
  const t = (batch: ToolCallSummary[]) => { const r = reduceBatch(s, batch, 'medium'); s = r.state; return r.outcome.progress; };
  assert.equal(t([fail('npm test', 'boom')]), 'new-failure');
  assert.equal(t([edit(), fail('npm test', 'boom')]), 'repeat-failure');
  assert.equal(t([read()]), 'steady');
  assert.equal(t([bash('npm test')]), 'resolved');
});

test('reducer: environment blockers are classified separately', () => {
  for (const result of [
    'npm ERR! network ECONNREFUSED registry.npmjs.org',
    'Error: connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND api.example.com',
    'bash: pytest: command not found',
    'EACCES: permission denied, open /etc/hosts',
    'npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/x',
    '503 Service Unavailable',
  ]) {
    assert.ok(isEnvironmentFailure(fail('cmd', result)), result);
  }
  for (const result of [
    'AssertionError: expected 3 === 4',
    'TypeError: cannot read properties of undefined',
    '1 failing test',
    'ENOENT: no such file or directory, open ./data.json',
  ]) {
    assert.equal(isEnvironmentFailure(fail('cmd', result)), false, result);
  }
  let s = emptyCore();
  s = reduceBatch(s, [fail('npm install', 'ECONNREFUSED')], 'medium').state;
  assert.equal(s.issues[0]!.environment, true);
  assert.equal(reasoningIssues(s).length, 0);
});

/* ---------- selective Jev ---------- */

test('Jev is consulted at task start and skipped for routine local steps', async () => {
  const jev = stubJev((_s, q) => 'task_type' in q
    ? { answers: { task_type: choice('code_small'), difficulty: score(1), stakes: noul(0.1) }, signals: allValid(Object.keys(q)) }
    : { answers: {}, signals: allValid(Object.keys(q)) });
  const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
  const t = await r.routeTask('rename the setting', null);
  assert.equal(t.source, 'jev');
  assert.equal(jev.calls.length, 1);

  const d = await r.routeStep(step([read()], t.effort));
  assert.equal(d.source, 'local', 'a quiet step decides locally');
  assert.equal(jev.calls.length, 1, 'no Jev call for a routine step');
});

test('Jev triggers: new failure, stalled recovery, proposed downgrade, unclear phase', async () => {
  const jev = stubJev(() => ({ answers: {}, signals: {} }));
  const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
  await r.routeTask('hi', null); // call 1
  const base = jev.calls.length;

  await r.routeStep(step([fail('npm test', 'AssertionError')], 'low'));
  assert.equal(jev.calls.length, base + 1, 'new failure asks Jev');

  const d1 = await r.routeStep(step([edit(), fail('npm test', 'AssertionError')], 'medium'));
  assert.equal(jev.calls.length, base + 2, 'the same issue failing again asks Jev');
  void d1;

  // A routine read while the issue is open decides locally — nothing could change.
  await r.routeStep(step([read()], 'high'));
  assert.equal(jev.calls.length, base + 2);

  // The failing test now passes: a downgrade is proposed → Jev is consulted.
  await r.routeStep(step([bash('npm test')], 'high'));
  assert.equal(jev.calls.length, base + 3, 'a proposed downgrade asks Jev');

  // An empty batch is ambiguous (phase confidence < 0.5) → Jev is consulted.
  await r.routeStep(step([], 'medium'));
  assert.equal(jev.calls.length, base + 4, 'unclear phase asks Jev');
});

/* ---------- escalation relative to attempted effort ---------- */

test('repeated failure escalates above the highest tried effort, up to bounds.max', async () => {
  const r = lowTask();
  const task = await r.routeTask('hi', null);
  assert.equal(task.effort, 'low');

  let current: Effort = task.effort;
  const path: Effort[] = [];
  for (let i = 0; i < 10; i++) {
    const d = await r.routeStep(step([edit(), fail('npm test', 'AssertionError: wrong value')], current, { turn: i + 1 }));
    path.push(d.effort);
    current = d.effort;
  }
  assert.deepEqual(path.slice(0, 4), ['medium', 'high', 'xhigh', 'max'], 'escalates one level above each tried effort');
  assert.ok(rank(current) > rank('high'), 'reproduction: low task + 10 failures must pass high when max is allowed');
  assert.equal(current, 'max');
});

test('a successful read between failures does not reset recovery', async () => {
  const r = lowTask();
  const t = await r.routeTask('hi', null);
  let d = await r.routeStep(step([fail('npm test', 'AssertionError')], t.effort));
  assert.equal(d.effort, 'medium');

  d = await r.routeStep(step([read()], d.effort));
  assert.equal(d.effort, 'medium', 'the read keeps the issue open — effort holds');

  d = await r.routeStep(step([edit(), fail('npm test', 'AssertionError')], d.effort));
  assert.equal(d.effort, 'high', 'same fingerprint + a different fix attempted → one above highest tried');
  assert.equal(issues(r).length, 1);
  assert.equal(issues(r)[0]!.attempts, 2);
});

/* ---------- environment blockers ---------- */

test('environment blockers hold the current effort and never escalate', async () => {
  const r = lowTask();
  const t = await r.routeTask('implement the export feature end to end', null);
  let current: Effort = t.effort;
  for (let i = 0; i < 6; i++) {
    const d = await r.routeStep(step([fail('npm install', 'npm ERR! network ECONNREFUSED registry.npmjs.org')], current, { turn: i + 1 }));
    assert.equal(d.effort, t.effort, 'registry outage repeats without reasoning escalation');
    current = d.effort;
  }
  assert.equal(issues(r).length, 1);
  assert.equal(issues(r)[0]!.environment, true);

  const held = await r.routeStep(step([fail('curl https://api', 'command not found')], 'high'));
  assert.equal(held.effort, 'high', 'a new environment blocker holds even at high');
});

/* ---------- de-escalation needs positive evidence ---------- */

test('successful reads and finishing never lower effort while an issue is open', async () => {
  const r = lowTask();
  const t = await r.routeTask('hi', null);
  let d = await r.routeStep(step([fail('npm test', 'AssertionError')], t.effort));
  assert.equal(d.effort, 'medium');

  d = await r.routeStep(step([read(), read('src/b.ts')], d.effort));
  assert.equal(d.effort, 'medium', 'a clean read cannot lower effort with an open issue');

  d = await r.routeStep(step([], d.effort)); // finishing-looking step
  assert.equal(d.effort, 'medium', 'finishing does not lower effort while the issue is open');

  d = await r.routeStep(step([bash('npm test')], d.effort));
  assert.equal(d.effort, 'low', 'once resolved and routine, effort steps down one level');
  d = await r.routeStep(step([read()], d.effort));
  assert.equal(d.effort, 'low');
});

/* ---------- bounds last ---------- */

test('bounds are validated and clamped after hysteresis', async () => {
  // min > max is a config error: swapped, not thrown.
  const swapped = new EffortRouter({ jev: null, bounds: { min: 'high', max: 'low' } });
  assert.deepEqual(swapped.bounds, { min: 'low', max: 'high' });

  // Reproduction for finding #6: current high, bounds low..low, routine read → low.
  const r = new EffortRouter({ jev: null, bounds: { min: 'low', max: 'max' } });
  await r.routeTask('hi', null);
  r.bounds = { min: 'low', max: 'low' }; // tightened mid-flight, as a manual control would
  const d = await r.routeStep(step([read()], 'high'));
  assert.equal(d.effort, 'low', 'the final effort respects the ceiling even after hysteresis');
});

/* ---------- malformed / missing Jev evidence ---------- */

test('a stub Jev returning {} keeps the local estimate', async () => {
  const empty = stubJev(() => ({ answers: {} }));
  const r = new EffortRouter({ jev: empty, bounds: { min: 'low', max: 'max' } });
  const local = lowTask();

  const t = await r.routeTask('Design the architecture for a billing migration', null);
  const l = await local.routeTask('Design the architecture for a billing migration', null);
  assert.equal(t.effort, l.effort, 'missing answers must not displace the fallback');
  assert.equal(t.source, 'heuristic');
  assert.equal(t.profile!.taskType, l.profile!.taskType);
  assert.equal(t.profile!.difficulty, l.profile!.difficulty);

  const s = await r.routeStep(step([fail('npm test', 'AssertionError')], t.effort));
  const ls = await local.routeStep(step([fail('npm test', 'AssertionError')], t.effort));
  assert.equal(s.effort, ls.effort);
  assert.equal(s.source, 'heuristic');
});

test('invalid signals keep the local estimate; present answers on old clients count as valid', async () => {
  // Validating client: difficulty answer present but flagged invalid → ignored.
  const invalid = stubJev(() => ({
    answers: { difficulty: score(4) },
    signals: { task_type: 'missing', difficulty: 'invalid', stakes: 'missing' },
  }));
  const r = new EffortRouter({ jev: invalid, bounds: { min: 'low', max: 'max' } });
  const t = await r.routeTask('hi', null);
  assert.equal(t.effort, 'low', 'invalid difficulty must not escalate the task');
  assert.equal(t.source, 'heuristic', 'nothing usable was merged');

  // Old client (no signals map): a present answer is applied.
  const legacy = stubJev(() => ({ answers: { task_type: choice('architecture'), difficulty: score(4), stakes: noul(0.9) } }));
  const r2 = new EffortRouter({ jev: legacy, bounds: { min: 'low', max: 'max' } });
  const t2 = await r2.routeTask('hi', null);
  assert.equal(t2.effort, 'max', 'a present answer on an old client counts as valid');
  assert.equal(t2.source, 'jev');
});

test('missing Jev evidence cannot itself cause a downgrade', async () => {
  const jev = stubJev((_s, q) => 'task_type' in q
    ? { answers: { task_type: choice('code_feature'), difficulty: score(2.5), stakes: noul(0.2) }, signals: allValid(Object.keys(q)) }
    : { answers: {}, signals: Object.fromEntries(Object.keys(q).map((n) => [n, 'missing' as const])) });
  const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
  const t = await r.routeTask('implement the feature', null);
  assert.ok(rank(t.effort) >= rank('high'));

  // Proposed downgrade → Jev consulted → all answers missing → local estimate holds.
  const d = await r.routeStep(step([read()], 'high'));
  assert.equal(d.source, 'heuristic');
  assert.ok(d.jevError);
  assert.equal(d.effort, 'medium', 'the local proposal stands; Jev evidence added nothing');
});

test('circuitOpen is treated as Jev unavailable', async () => {
  const jev = stubJev(() => ({ answers: {}, circuitOpen: true }));
  const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
  const t = await r.routeTask('fix the bug', null);
  assert.equal(t.source, 'heuristic');
  assert.match(t.jevError ?? '', /circuit/);
});

test('Jev can veto a proposed downgrade', async () => {
  const jev = stubJev((_s, q) => 'task_type' in q
    ? { answers: { task_type: choice('code_feature'), difficulty: score(2.5), stakes: noul(0.2) }, signals: allValid(Object.keys(q)) }
    : { answers: { phase: choice('diagnosing', 0.9), step_difficulty: score(3.5), stuck: noul(0.4) }, signals: allValid(Object.keys(q)) });
  const r = new EffortRouter({ jev, bounds: { min: 'low', max: 'max' } });
  const t = await r.routeTask('implement the feature', null);
  const d = await r.routeStep(step([read()], 'high', { profile: t.profile }));
  assert.equal(d.source, 'jev');
  assert.ok(rank(d.effort) >= rank('high'), 'a confident diagnosing answer blocks the downgrade');
});

/* ---------- snapshot / restore ---------- */

test('snapshot/restore round-trips reducer state, tolerates older and garbage input', async () => {
  const r = lowTask();
  await r.routeTask('hi', null);
  await r.routeStep(step([fail('npm test', 'AssertionError')], 'low'));
  const snap = JSON.parse(JSON.stringify(r.snapshot())) as RouterSnapshot;
  assert.equal(snap.v, 2);

  const r2 = lowTask();
  await r2.routeTask('hi', null);
  r2.restore(snap);
  // The restored router still sees the open issue: a clean read cannot de-escalate.
  const held = await r2.routeStep(step([read()], 'medium'));
  assert.equal(held.effort, 'medium');
  assert.equal(issues(r2).length, 1);

  // v1 snapshots restore hold/base and start with no tracked issues.
  const r3 = lowTask();
  r3.restore({ v: 1, hold: 1, base: 'high' });
  const d = await r3.routeStep(step([read()], 'medium'));
  assert.equal(issues(r3).length, 0);
  assert.ok(rank(d.effort) <= rank('medium'));

  // Garbage is tolerated, never fatal.
  for (const junk of [null, undefined, 42, 'x', [], { v: 'x' }, { v: 99, hold: 'NaN' }] as const) {
    r3.restore(junk as unknown as RouterSnapshot);
  }
  const after = await r3.routeStep(step([read()], 'medium'));
  assert.equal(after.kind, 'step');
});

test('restore returns the controller to the snapshotted ancestor state', async () => {
  const r = lowTask();
  await r.routeTask('hi', null);
  const clean = r.snapshot();
  await r.routeStep(step([fail('npm test', 'AssertionError')], 'low'));
  await r.routeStep(step([fail('npm test', 'AssertionError')], 'medium'));
  assert.equal(issues(r).length, 1);
  r.restore(clean);
  assert.equal(issues(r).length, 0, 'rewind drops the abandoned branch’s issues');
  const d = await r.routeStep(step([read()], 'medium'));
  assert.equal(d.effort, 'low', 'with the issue gone, a routine step can de-escalate');
});

/* ---------- provenance ---------- */

test('decisions carry policy and question-set versions', async () => {
  const r = lowTask();
  const t = await r.routeTask('hi', null);
  const s = await r.routeStep(step([read()], t.effort));
  for (const d of [t, s]) {
    assert.equal(d.policyVersion, POLICY_VERSION);
    assert.deepEqual(d.questionVersions, { task: TASK_SET_VERSION, step: STEP_SET_VERSION });
  }
});
