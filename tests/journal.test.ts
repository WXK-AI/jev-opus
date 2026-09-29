import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Journal, type JournalRecord } from '../src/gateway/journal.ts';
import { GATEWAY_AUTH_HEADER, JevGateway } from '../src/gateway/server.ts';
import { effortInForce, prefixHashes, type Message } from '../src/gateway/transcript.ts';
import { neutralAnswers, parseAnswers, type JevLike, type JevQuestion, type JevResult } from '../src/jev/client.ts';

const TEST_AUTH_TOKEN = 'test-gateway-token';
const testGateway = (opts: ConstructorParameters<typeof JevGateway>[0]) => new JevGateway({ ...opts, authToken: TEST_AUTH_TOKEN });

function scriptedJev(script: Array<Record<string, unknown>>): JevLike & { calls: number } {
  const jev = {
    enabled: true,
    calls: 0,
    async ask(_state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
      jev.calls++;
      const raw = script.shift();
      return raw
        ? { answers: parseAnswers(raw, questions), failed: false, latencyMs: 1, inputTokens: 10 }
        : { answers: neutralAnswers(questions), failed: true, error: 'exhausted', latencyMs: 0, inputTokens: 0 };
    },
  };
  return jev;
}

interface Seen { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | null }

const SSE_OK =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function fakeUpstream(handler?: Handler): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    if (handler) return handler(req, res);
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_OK);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', authorization: 'Bearer secret', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return res.text();
}

const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
const u = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (id: string, command: string, text = ''): Message => ({
  role: 'assistant',
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name: 'Bash', input: { command } }],
});
const r = (id: string, content: string, is_error = false): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] });
const body = (messages: Message[]) => ({ model: 'jev/claude-opus-5-5', stream: true, tools, output_config: { effort: 'low' }, messages });
const journalKey = (session: string, messages: Message[]) => `${session}|main|${prefixHashes(messages)[1]!.slice(0, 16)}`;

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r2) => setTimeout(r2, 10));
  }
  return cond();
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-journal-'));
}

test('a new append repairs an interrupted final journal line', () => {
  const dir = tmpdir();
  try {
    const journal = new Journal(dir);
    journal.append('session', { decisionId: 'd1', status: 'sent', at: 1 });
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.appendFileSync(file, '{"decisionId":"interrupted');
    assert.equal(journal.events('session').length, 1, 'the incomplete tail is ignored before recovery');
    journal.append('session', { decisionId: 'd1', status: 'completed', at: 2 });
    assert.deepEqual(journal.events('session').map((event) => 'status' in event ? event.status : undefined), ['sent', 'completed']);

    // A complete JSON record with only its newline missing remains valid.
    fs.appendFileSync(file, '{"decisionId":"d2","status":"sent","at":3}');
    journal.append('session', { decisionId: 'd2', status: 'completed', at: 4 });
    assert.deepEqual(journal.events('session').map((event) => 'status' in event ? event.status : undefined), ['sent', 'completed', 'sent', 'completed']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('journal folds status/usage updates onto prepared records and stays owner-only', () => {
  const dir = tmpdir();
  const jdir = path.join(dir, 'journal');
  try {
    const j = new Journal(jdir);
    const rec: JournalRecord = {
      decisionId: 'd1', requestFingerprint: 'fp', lastUser: 0, boundaryHash: 'h1',
      insertions: [{ index: 0, effort: 'high', prefixHash: 'h0' }],
      routerSnapshot: { v: 1 }, policy: 'test', requested: 'high', current: 'low',
      kind: 'task', manual: false, turn: 0, consecutiveFailures: 0, clientEffort: null,
      profile: null, status: 'prepared', at: 1,
    };
    j.append('sess|main|abc', rec);
    j.append('sess|main|abc', { decisionId: 'd1', status: 'sent', at: 2 });
    j.append('sess|main|abc', { decisionId: 'd1', status: 'completed', at: 3, usage: { outputTokens: 42, inputTokens: 100 } });

    const [folded] = j.records('sess|main|abc');
    assert.equal(folded!.status, 'completed');
    assert.equal(folded!.usage!.outputTokens, 42);
    assert.equal(folded!.requested, 'high');
    assert.equal(j.records('other').length, 0);

    const files = fs.readdirSync(jdir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[0-9a-f]+\.jsonl$/, 'file name is a hash, not the raw key');
    assert.equal(fs.statSync(path.join(jdir, files[0]!)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(jdir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single-flight: a duplicate request joins the in-flight decision and reuses its exact transformation', async () => {
  const up = await fakeUpstream();
  let release!: (raw: Record<string, unknown>) => void;
  const gate = new Promise<Record<string, unknown>>((res) => (release = res));
  const jev = {
    enabled: true,
    calls: 0,
    async ask(_state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
      jev.calls++;
      const raw = await gate;
      return { answers: parseAnswers(raw, questions), failed: false, latencyMs: 5, inputTokens: 10 };
    },
  };
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const request = body([u('fix the flaky date test')]);
    const p1 = post(base, request);
    const p2 = post(base, request); // identical, sent while Jev is still held
    await new Promise((r2) => setTimeout(r2, 30));
    assert.equal(jev.calls, 1, 'the duplicate joins the pending decision instead of routing again');
    assert.equal(up.seen.length, 0, 'nothing is forwarded before the decision is prepared');
    release({ task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 3.5 }, stakes: { noul: 0.2 } });
    await Promise.all([p1, p2]);
    await until(() => up.seen.length === 2);
    const m1 = up.seen[0]!.body!.messages as Message[];
    const m2 = up.seen[1]!.body!.messages as Message[];
    assert.deepEqual(m2, m1, 'both requests are forwarded byte-identically');
    assert.deepEqual(m1[0], { role: 'system', content: [], output_config: { effort: 'high' } }, 'the inserted statement is present in both');
    assert.equal(jev.calls, 1);
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changed history at the same boundary is a new decision routed from the common ancestor', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } }, // task → medium
    { phase: { choice: 'exploring', confidence: 0.9 }, step_difficulty: { score: 0.5 }, stuck: { noul: 0.1 } }, // ok result → low
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.5 }, stuck: { noul: 0.1 } }, // failed result → high
  ]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    await post(base, body(m1));
    const mOk = [...m1, a('t1', 'npm test'), r('t1', '# pass 3 # fail 0')];
    await post(base, body(mOk));
    const sentOk = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentOk[3], { role: 'system', content: [], output_config: { effort: 'low' } }, 'a successful step de-escalates to low');

    // Same last-user index, different fingerprint: the tool result changed from success to failure.
    const mFail = [...m1, a('t1', 'npm test'), r('t1', 'Exit code 1: 2 failing', true)];
    await post(base, body(mFail));
    assert.equal(jev.calls, 3, 'changed history re-routes instead of replaying');
    const sentFail = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentFail[0], sentOk[0], 'the shared-prefix insertion is still replayed');
    const lastStmt = sentFail.filter((m) => m.role === 'system').at(-1)!;
    assert.equal(lastStmt.output_config?.effort, 'high', 'the newest statement governs the changed result');
    assert.deepEqual(sentFail[sentFail.indexOf(lastStmt) + 1], r('t1', 'Exit code 1: 2 failing', true));

    const recs = new Journal(dir).records(journalKey('sess-1', m1));
    assert.equal(recs.length, 3, 'both boundaries are journaled');
    assert.equal(recs.at(-1)!.requested, 'high');
    assert.equal(recs.at(-1)!.lastUser, 2);
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returning to an older branch restores the effort statements that branch already saw', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const gw = testGateway({ jev: null, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const first = [u('fix the bug')];
    await post(base, body(first));
    const branchA = [...first, a('t1', 'npm test'), r('t1', 'FAIL assertion', true)];
    await post(base, body(branchA));
    const sentA = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(sentA[3]!.output_config?.effort, 'high');

    const branchB = [...first, a('t2', 'ls'), r('t2', 'index.ts')];
    await post(base, body(branchB));
    await post(base, body([...branchA, a('t3', 'cat index.ts'), r('t3', 'source')]));
    const continuedA = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(continuedA.slice(0, sentA.length), sentA,
      'a sibling branch must not erase an effort statement already sent on this branch');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a client disconnect during evaluation prevents upstream dispatch', async () => {
  const up = await fakeUpstream();
  let entered!: () => void;
  let release!: () => void;
  const evaluating = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const jev: JevLike = {
    enabled: true,
    async ask(_state, questions) {
      entered();
      await gate;
      return { answers: parseAnswers({ task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 2.5 }, stakes: { noul: 0.1 } }, questions), failed: false, latencyMs: 1, inputTokens: 1 };
    },
  };
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const messages = [u('fix the bug')];
    const controller = new AbortController();
    const request = fetch(`${base}/v1/messages`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
      body: JSON.stringify(body(messages)),
    });
    await evaluating;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    // Let the aborted socket's close event reach the gateway before Jev answers.
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    assert.equal(await until(() => new Journal(dir).records(journalKey('sess-1', messages)).length === 1), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(up.seen.length, 0, 'a completed decision must not dispatch after its client disconnects');
  } finally {
    release();
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an active decision survives thread cache eviction and keeps duplicate requests single-flight', async () => {
  const up = await fakeUpstream();
  let entered!: () => void;
  let release!: () => void;
  const evaluating = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const jev: JevLike = {
    enabled: true,
    async ask(_state, questions) {
      const n = ++calls;
      if (n === 1) { entered(); await gate; }
      return { answers: parseAnswers({ task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: n === 1 ? 3.5 : 1 }, stakes: { noul: 0.1 } }, questions), failed: false, latencyMs: 1, inputTokens: 1 };
    },
  };
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, maxThreads: 1 });
  const base = await gw.listen();
  try {
    const request = body([u('fix the bug')]);
    const first = post(base, request, { 'x-claude-code-session-id': 'sess-A' });
    await evaluating;
    await post(base, body([u('another task')]), { 'x-claude-code-session-id': 'sess-B' });
    const duplicate = post(base, request, { 'x-claude-code-session-id': 'sess-A' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 2, 'the duplicate joins the active decision, even when another thread fills the cache');
    release();
    await Promise.all([first, duplicate]);
    const sentA = up.seen.filter((seen) => (seen.body?.messages as Message[]).some((m) =>
      m.role === 'user' && Array.isArray(m.content) && m.content.some((b: { text?: string }) => b.text === 'fix the bug')));
    assert.equal(sentA.length, 2);
    assert.deepEqual(sentA[0]!.body!.messages, sentA[1]!.body!.messages);
  } finally {
    release();
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thread eviction rebuilds from the journal: maxThreads 1 keeps the original insertion', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } }, // A task → medium
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 3.0 }, stakes: { noul: 0.2 } }, // B task → high
    { phase: { choice: 'verifying', confidence: 0.9 }, step_difficulty: { score: 1.0 }, stuck: { noul: 0.1 } }, // A step
  ]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, maxThreads: 1 });
  const base = await gw.listen();
  try {
    const mA = [u('rename x to y')];
    await post(base, body(mA), { 'x-claude-code-session-id': 'sess-A' });
    const sentA = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentA[0], { role: 'system', content: [], output_config: { effort: 'medium' } });

    await post(base, body([u('debug the billing crash')]), { 'x-claude-code-session-id': 'sess-B' }); // evicts A

    const mA2 = [...mA, a('t1', 'npm test'), r('t1', 'PASS 3 tests')];
    await post(base, body(mA2), { 'x-claude-code-session-id': 'sess-A' });
    const sentA2 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentA2[0], sentA[0], "A's original insertion is still present after eviction");
    assert.deepEqual(sentA2[3], { role: 'system', content: [], output_config: { effort: 'low' } }, 'the rebuilt router continues with a step decision');
    assert.equal(jev.calls, 3);
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway restart: a new instance continues the conversation from the same journal', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const m1 = [u('rename x to y')];

  const jev1 = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } },
  ]);
  const gw1 = testGateway({ jev: jev1, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base1 = await gw1.listen();
  await post(base1, body(m1));
  const sent1 = up.seen.at(-1)!.body!.messages as Message[];
  await gw1.close();

  const jev2 = scriptedJev([
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.5 }, stuck: { noul: 0.1 } }, // → high
  ]);
  const gw2 = testGateway({ jev: jev2, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base2 = await gw2.listen();
  try {
    const m2 = [...m1, a('t1', 'npm test'), r('t1', 'Exit code 1', true)];
    await post(base2, body(m2));
    const sent2 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sent2[0], sent1[0], 'the pre-restart insertion is replayed');
    assert.deepEqual(sent2[3], { role: 'system', content: [], output_config: { effort: 'high' } }, 'and the restored router routes the step');
    assert.equal(jev2.calls, 1);

    // A replay of the pre-restart request also survives a restart.
    await post(base2, body(m1));
    const retry = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(retry, sent1, 'a retry of a pre-restart request replays its exact transformation');
    assert.equal(jev2.calls, 1, 'the journaled decision is reused without asking Jev again');
  } finally {
    await gw2.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway restart: a manual /effort from the last prompt does not survive into the next automatic prompt', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const stmt = (effort: string): Message => ({ role: 'system', content: [], output_config: { effort } });
  const bounds = { min: 'low', max: 'low' } as const;
  const m1 = [u('rename x to y'), stmt('medium')];
  const m2 = [...m1, a('t1', 'ls'), stmt('high'), r('t1', 'a.js')];
  const gw1 = testGateway({ jev: null, bounds, upstream: up.url, journalDir: dir });
  const base1 = await gw1.listen();
  await post(base1, body(m1));
  await post(base1, body(m2));
  assert.equal(effortInForce(up.seen.at(-1)!.body!.messages as Message[], 'low'), 'high', 'the manual override applies to its own prompt');
  await gw1.close();

  const gw2 = testGateway({ jev: null, bounds, upstream: up.url, journalDir: dir });
  const base2 = await gw2.listen();
  try {
    const m3: Message[] = [...m2, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, u('now rename y to z')];
    await post(base2, body(m3));
    const sent = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(effortInForce(sent, 'low'), 'low', 'automatic routing resumes at its own level, within bounds');
  } finally {
    await gw2.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit --holds names the tool call and cause behind every open failure', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const gw = testGateway({ jev: null, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('fix the failing date tests')];
    const m2 = [...m1, a('toolu_diff', 'git diff -- src/checks.ts'), r('toolu_diff', '+const FAILURE_MARKER = /FAILED|FAIL/;\nFAIL\n')];
    const m3 = [...m2, a('toolu_test', 'npm test 2>&1 | tail -3'), r('toolu_test', '# pass 4\n# fail 2\n')];
    const m4 = [...m3, a('toolu_other', 'cd web && npm test 2>&1 | tail -3'), r('toolu_other', '# pass 9\n# fail 0\n')];
    const m5 = [...m4, a('toolu_read', 'cat index.ts'), r('toolu_read', 'source')];
    for (const m of [m1, m2, m3, m4, m5]) await post(base, body(m));

    const { auditJournal, formatAudit } = await import('../src/gateway/audit.ts');
    const all = auditJournal(dir);
    assert.equal(all.summary.decisions, 5);
    assert.equal(all.summary.holds.decisions, 3, 'the git diff opened nothing; the failing suite stays open through an unrelated pass and read');
    assert.equal(all.summary.holds.blocked, 1, 'the escalation and its one-step delay do not count; the later read is held by the issue');
    assert.deepEqual(all.summary.holds.byCause, { 'check-summary': 1 });
    const text = formatAudit(all);
    assert.match(text, /open I-[0-9a-f]{8} · check-summary from toolu_test · opened this step · 1 failed run at \w+ · clears when the same check passes/);
    assert.match(text, /observed: toolu_test check failed \(check-summary\)/);
    const held = auditJournal(dir, '', { holds: true });
    assert.equal(held.summary.decisions, 1);
    const heldText = formatAudit(held);
    assert.match(heldText, /held at HIGH: the open issues below blocked a step down\n  open I-[0-9a-f]{8} · check-summary from toolu_test · open 2 steps · /);
    assert.doesNotMatch(JSON.stringify(held), /FAILURE_MARKER|npm test|# fail/, 'no command or output text in the audit');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every replay-only request follows its own branch in memory and after restart', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const statusDir = tmpdir();
  let decisions = 0;
  const options = { jev: null, bounds: { min: 'low', max: 'high' } as const, upstream: up.url, journalDir: dir, statusDir, onDecision: () => { decisions++; } };
  let gw = testGateway(options);
  let base = await gw.listen();
  try {
    const first = [u('fix the bug')];
    await post(base, body(first));
    const branchA = [...first, a('t1', 'npm test'), r('t1', 'FAIL assertion', true)];
    await post(base, body(branchA));
    const sentA = up.seen.at(-1)!.body!.messages as Message[];
    const branchB = [...first, a('t1', 'npm test'), r('t1', '# pass 3\n# fail 0')];
    await post(base, body(branchB));
    const sentB = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(effortInForce(sentA, 'low'), 'high');
    assert.equal(effortInForce(sentB, 'low'), 'low');
    const events = () => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    const before = events();
    const status = fs.readFileSync(path.join(statusDir, 'sess-1.json'), 'utf8');
    for (const restart of [false, true]) {
      if (restart) {
        await gw.close();
        gw = testGateway(options);
        base = await gw.listen();
      }
      for (const [original, generated] of [[branchA, sentA], [branchB, sentB], [branchA, sentA]] as const) {
        const suffix: Message[] = [{ role: 'assistant', content: 'Done.' }, u('[SUGGESTION MODE: Suggest the next prompt.]')];
        for (const [endpoint, includeTools] of [['/v1/messages/count_tokens', true], ['/v1/messages', false], ['/v1/messages', true]] as const) {
          const res = await fetch(base + endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
            body: JSON.stringify({ ...body([...original, ...suffix]), tools: includeTools ? tools : [] }),
          });
          await res.text();
          assert.equal(res.status, 200);
          assert.deepEqual(up.seen.at(-1)!.body!.messages, [...generated, ...suffix], `${endpoint}, tools=${includeTools}, restarted=${restart}`);
          assert.match(String(up.seen.at(-1)!.headers['anthropic-beta']), /mid-conversation-output-config/);
        }
      }
      assert.equal(decisions, 3, 'replay never routes');
      assert.equal(events(), before, 'replay never journals');
      assert.equal(fs.readFileSync(path.join(statusDir, 'sess-1.json'), 'utf8'), status, 'replay never changes status');
    }
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

test('replay-only requests do not forward an incomplete transcript when recovery fails', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const notices: string[] = [];
  const options = { jev: null, bounds: { min: 'low', max: 'high' } as const, upstream: up.url, journalDir: dir, onNotice: (notice: string) => { notices.push(notice); } };
  let gw = testGateway(options);
  let base = await gw.listen();
  try {
    const messages = [u('fix the bug')];
    await post(base, body(messages));
    await gw.close();
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.appendFileSync(file, 'invalid journal record\n');
    const before = fs.readFileSync(file, 'utf8');
    gw = testGateway(options);
    base = await gw.listen();
    for (const endpoint of ['/v1/messages/count_tokens', '/v1/messages']) {
      const res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
        body: JSON.stringify({ model: 'jev/claude-opus-5-5', messages }),
      });
      assert.equal(res.status, 502);
      assert.match(await res.text(), /Cannot read recovery journal/);
    }
    assert.equal(up.seen.length, 1, 'only the original generation was forwarded');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'recovery does not rewrite a corrupt journal');
    assert.ok(notices.some((notice) => notice.startsWith('journal read error (replay only):')));
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('token counting and tool-less requests replay earlier statements without deciding anything', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const statusDir = tmpdir();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 2.8 }, stakes: { noul: 0.1 } }, // → high (top level is low)
  ]);
  const send = async (base: string, url: string, payload: unknown) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
    body: JSON.stringify(payload),
  }).then((res) => res.text());
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, statusDir });
  const base = await gw.listen();
  const m1 = [u('rename x to y')];
  const next = [...m1, { role: 'assistant', content: [{ type: 'text', text: 'done' }] } as Message, u('thanks')];
  let gw2: JevGateway | undefined;
  try {
    await post(base, body(m1));
    const generated = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(generated.length, 2, 'the prompt got an inserted statement');
    const events = () => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    const before = events();
    const status = fs.readFileSync(path.join(statusDir, 'sess-1.json'), 'utf8');

    await send(base, '/v1/messages/count_tokens', { model: 'jev/claude-opus-5-5', tools, messages: next });
    const counted = up.seen.at(-1)!;
    assert.equal(counted.url, '/v1/messages/count_tokens');
    assert.equal(counted.body!.model, 'claude-opus-5-5');
    assert.deepEqual((counted.body!.messages as Message[]).slice(0, 2), generated, 'the counted transcript matches the generated one');
    assert.match(String(counted.headers['anthropic-beta']), /mid-conversation-output-config/);

    await send(base, '/v1/messages', { model: 'jev/claude-opus-5-5', stream: true, messages: next });
    assert.deepEqual((up.seen.at(-1)!.body!.messages as Message[]).slice(0, 2), generated, 'a tool-less side request keeps the prefix');

    assert.equal(jev.calls, 1, 'nothing was routed');
    assert.equal(events(), before, 'no decision or attempt was journaled');
    assert.equal(fs.readFileSync(path.join(statusDir, 'sess-1.json'), 'utf8'), status, 'the status line did not move');

    // After a restart the journal alone supplies the replay.
    await gw.close();
    gw2 = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
    const base2 = await gw2.listen();
    await send(base2, '/v1/messages/count_tokens', { model: 'jev/claude-opus-5-5', messages: next });
    assert.deepEqual((up.seen.at(-1)!.body!.messages as Message[]).slice(0, 2), generated);

    // An unrelated conversation has nothing to replay and passes through unchanged.
    const other = [u('something else')];
    await send(base2, '/v1/messages/count_tokens', { model: 'jev/claude-opus-5-5', messages: other });
    assert.deepEqual(up.seen.at(-1)!.body!.messages, other);
    assert.equal(up.seen.at(-1)!.headers['anthropic-beta'], undefined);
  } finally {
    await (gw2 ?? gw).close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

test('switching to another model clears the Jev status line', async () => {
  const up = await fakeUpstream();
  const statusDir = tmpdir();
  const gw = testGateway({ jev: null, bounds: { min: 'low', max: 'high' }, upstream: up.url, statusDir });
  const base = await gw.listen();
  const { statusLineText } = await import('../src/gateway/launch.ts');
  const line = (model: Record<string, string> | undefined) => statusLineText(JSON.stringify({ session_id: 'sess-1', ...(model ? { model } : {}) }), statusDir);
  try {
    await post(base, body([u('rename x to y')]));
    assert.match(line({ id: 'jev/claude-opus-5-5', display_name: 'Opus 5.5' }), /^◆ Jev · \w/);
    assert.match(line({ id: 'claude-sonnet-5', display_name: 'Sonnet 5' }), /off/, 'another model selected: the saved Jev state is stale');

    await post(base, { ...body([u('rename x to y')]), model: 'claude-sonnet-5' });
    assert.equal(fs.existsSync(path.join(statusDir, 'sess-1.json')), false, 'the switch removes the saved state');
    assert.match(line(undefined), /off/);
    assert.match(line({ id: 'jev/claude-opus-5-5' }), /waiting for the first step/, 'switching back shows no stale level before the next decision');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

test('telemetry: SSE usage and stop_reason are journaled as completed', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } },
  ]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    const sse = await post(base, body(m1));
    assert.match(sse, /message_stop/, 'the stream reaches the client unchanged');

    const j = new Journal(dir);
    const key = journalKey('sess-1', m1);
    assert.ok(await until(() => j.records(key).at(-1)?.status === 'completed'));
    const rec = j.records(key).at(-1)!;
    assert.equal(rec.usage!.outputTokens, 42);
    assert.equal(rec.usage!.inputTokens, 100);
    assert.equal(rec.usage!.cacheReadInputTokens, 50);
    assert.equal(rec.usage!.cacheCreationInputTokens, 10);
    assert.equal(rec.usage!.stopReason, 'end_turn');
    assert.equal(rec.usage!.model, 'claude-opus-5-5');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry: non-streaming JSON usage completes; upstream error status fails', async () => {
  const jsonUp = await fakeUpstream((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 9 } }));
    });
  });
  const dir = tmpdir();
  const jev = scriptedJev([{ task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }]);
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: jsonUp.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    const text = await post(base, { ...body(m1), stream: false });
    const parsed = JSON.parse(text) as { usage: { output_tokens: number } };
    assert.equal(parsed.usage.output_tokens, 9, 'the JSON body reaches the client unchanged');

    const j = new Journal(dir);
    const key = journalKey('sess-1', m1);
    assert.ok(await until(() => j.records(key).at(-1)?.status === 'completed'));
    assert.equal(j.records(key).at(-1)!.usage!.outputTokens, 9);
  } finally {
    await gw.close();
    jsonUp.close();
  }

  // A second gateway + session whose upstream answers 500 is journaled as failed.
  const failUp = await fakeUpstream((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => res.writeHead(500).end('upstream exploded'));
  });
  const gw2 = testGateway({
    jev: scriptedJev([{ task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }]),
    bounds: { min: 'low', max: 'high' },
    upstream: failUp.url,
    journalDir: dir,
  });
  const base2 = await gw2.listen();
  try {
    const m2 = [u('rename y to z')];
    const res = await fetch(`${base2}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-2', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
      body: JSON.stringify(body(m2)),
    });
    assert.equal(res.status, 500, 'the upstream error status passes through');
    const j = new Journal(dir);
    const key2 = journalKey('sess-2', m2);
    assert.ok(await until(() => j.records(key2).at(-1)?.status === 'failed'));
  } finally {
    await gw2.close();
    failUp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry: a client disconnect leaves the outcome unknown, never deleting the record', async () => {
  const up = await fakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n');
      const timer = setTimeout(() => res.end(), 60_000); // the rest never arrives in time
      res.on('close', () => clearTimeout(timer));
    });
  });
  const jev = scriptedJev([{ task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', [GATEWAY_AUTH_HEADER]: TEST_AUTH_TOKEN },
      body: JSON.stringify(body(m1)),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // the first event arrived
    ac.abort();
    await reader.read().catch(() => undefined);

    const j = new Journal(dir);
    const key = journalKey('sess-1', m1);
    assert.ok(await until(() => j.records(key).at(-1)?.status === 'unknown'));
    const rec = j.records(key).at(-1)!;
    assert.equal(rec.status, 'unknown');
    assert.equal(rec.requested, 'low', 'the prepared decision is kept, not reconstructed');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal stores hashes and efforts only — no prompt text or credentials', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([{ task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    await post(base, body([u('rename the SECRETPHRASE token')]), { authorization: 'Bearer topsecretvalue' });
    assert.equal(up.seen.at(-1)!.headers.authorization, 'Bearer topsecretvalue', 'credential still forwarded unchanged');
    const content = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(!content.includes('SECRETPHRASE'), 'no prompt text in the journal');
    assert.ok(!content.includes('topsecretvalue'), 'no credentials in the journal');
    assert.ok(!content.includes('Bearer'));
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalization: cache_control inside tool arguments is real input, block-level stays a breakpoint', async () => {
  const withArgsCc = a('t1', 'ls');
  (withArgsCc.content as Array<Record<string, unknown>>)[0]!.input = { command: 'ls', cache_control: { type: 'ephemeral' } };
  const base1 = prefixHashes([u('x'), a('t1', 'ls')]);
  const argsCc = prefixHashes([u('x'), withArgsCc]);
  assert.notEqual(argsCc[2], base1[2], 'cache_control inside tool_use.input changes the fingerprint');

  const withBlockCc = a('t1', 'ls');
  (withBlockCc.content as Array<Record<string, unknown>>)[0]!.cache_control = { type: 'ephemeral' };
  const blockCc = prefixHashes([u('x'), withBlockCc]);
  assert.equal(blockCc[2], base1[2], 'cache_control on the block itself is still canonicalized away');

  // …and end to end: a request that differs only by a cache_control inside tool args re-routes.
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } },
    { phase: { choice: 'exploring', confidence: 0.9 }, step_difficulty: { score: 0.5 }, stuck: { noul: 0.1 } },
    { phase: { choice: 'verifying', confidence: 0.9 }, step_difficulty: { score: 1.0 }, stuck: { noul: 0.1 } },
  ]);
  const dir = tmpdir();
  let decisions = 0;
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, onDecision: () => { decisions++; } });
  const url = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    await post(url, body(m1));
    const m2 = [...m1, a('t1', 'ls'), r('t1', 'dates.js')];
    await post(url, body(m2));
    const m3 = [...m1, withArgsCc, r('t1', 'dates.js')]; // same index, args differ only by cache_control
    await post(url, body(m3));
    // Count routing decisions, not Jev calls: the selective policy decides routine steps locally.
    assert.equal(decisions, 3, 'a cache_control inside tool arguments is a new boundary');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry: a response longer than the copy cap still records the final usage', async () => {
  // ~600 KB of content deltas between message_start and message_delta, like a large file write.
  const filler = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"' + 'x'.repeat(2000) + '"}}\n\n';
  const long = SSE_OK.split('event: message_delta')[0] + filler.repeat(300) + 'event: message_delta' + SSE_OK.split('event: message_delta')[1];
  const up = await fakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(long);
    });
  });
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } },
  ]);
  const dir = tmpdir();
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('write a big file')];
    const sse = await post(base, body(m1));
    assert.equal(sse.length, long.length, 'the client receives every byte');
    const j = new Journal(dir);
    const key = journalKey('sess-1', m1);
    assert.ok(await until(() => j.records(key).at(-1)?.status === 'completed'));
    const rec = j.records(key).at(-1)!;
    assert.equal(rec.usage!.inputTokens, 100, 'message_start usage from the head');
    assert.equal(rec.usage!.outputTokens, 42, 'final message_delta usage from the tail');
    assert.equal(rec.usage!.stopReason, 'end_turn');
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a next-prompt suggestion fork replays statements but is never routed or recorded', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } },
  ]);
  const dir = tmpdir();
  const decided: string[] = [];
  const gw = testGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, onDecision: (_s, d) => decided.push(d.kind) });
  const base = await gw.listen();
  try {
    const m1 = [u('the date test fails, fix it')];
    await post(base, body(m1));
    const sent1 = up.seen.at(-1)!.body!.messages as Message[];
    const fork = [...m1, { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } as Message,
      u('[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nFIRST: Look at the user\'s recent messages')];
    await post(base, body(fork));
    const sentFork = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentFork.slice(0, sent1.length), sent1, 'the fork carries the same prefix, so it shares the cache');
    assert.equal(sentFork.length, sent1.length + 2, 'no new statement for the fork');
    assert.deepEqual(decided, ['task'], 'only the real prompt was routed');
    assert.equal(jev.calls, 1);
  } finally {
    await gw.close();
    up.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retries have separate attempts, summed usage, stable decision IDs, and durable annotations', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const traces: Array<Record<string, unknown>> = [];
  const gw = testGateway({ jev: null, bounds: { min: 'medium', max: 'medium' }, upstream: up.url, journalDir: dir, trace: (e) => traces.push(e) });
  const base = await gw.listen();
  try {
    const messages = [u('test audit')];
    await Promise.all([post(base, body(messages)), post(base, body(messages))]);
    const journal = new Journal(dir);
    const key = journalKey('sess-1', messages);
    const [rec] = journal.records(key);
    assert.equal(journal.records(key).length, 1);
    assert.equal(rec.attempts!.length, 2);
    assert.equal(new Set(rec.attempts!.map((a) => a.attemptId)).size, 2);
    assert.equal(rec.usage!.outputTokens, 84);
    assert.ok(rec.attempts!.every((a) => a.usageComplete && a.status === 'completed'));
    assert.equal(traces[0].decisionId, rec.decisionId);
    assert.ok(rec.decision!.reasons.length);
    assert.ok(rec.at <= rec.updatedAt!);
    const rendered = await fetch(base + gw.displayHookPath, { method:'POST',body:JSON.stringify({hook_event_name:'MessageDisplay',session_id:'sess-1',turn_id:'turn',message_id:'display',index:0,delta:'Hello'}) }).then((r) => r.json());
    assert.doesNotMatch(JSON.stringify(rendered), /D-[0-9a-f]{8}/, 'decision IDs stay out of default badges');
    const annotations = journal.events(key).filter((e) => 'event' in e);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].decisionId, rec.decisionId);
    const { auditJournal } = await import('../src/gateway/audit.ts');
    const report = auditJournal(dir, `D-${rec.decisionId.slice(0,8)}`);
    assert.equal(report.summary.observedOutputTokens, 84);
    assert.equal(report.summary.attempts, 2);
    assert.equal(report.journals[0].events.length, journal.events(key).length);
  } finally { await gw.close(); up.close(); fs.rmSync(dir, {recursive:true,force:true}); }
});

test('HTTP 200 stream errors fail; EOF without message_stop remains unknown', async () => {
  for (const scenario of ['error', 'incomplete']) {
    const text = SSE_OK.split('event: message_delta')[0] + (scenario === 'error' ? 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"PRIVATE"}}\n\n' : '');
    const up = await fakeUpstream((req,res) => { req.resume(); req.on('end',() => res.writeHead(200,{'content-type':'text/event-stream'}).end(text)); });
    const dir = tmpdir();
    const gw = testGateway({jev:null,bounds:{min:'low',max:'high'},upstream:up.url,journalDir:dir});
    const base = await gw.listen();
    try {
      const messages = [u('test protocol')];
      assert.equal(await post(base,body(messages)), text);
      const rec = new Journal(dir).records(journalKey('sess-1',messages))[0];
      assert.equal(rec.status, scenario === 'error' ? 'failed' : 'unknown');
      assert.equal(rec.attempts![0].usageComplete, false);
      assert.equal(JSON.stringify(rec).includes('PRIVATE'),false);
    } finally { await gw.close(); up.close(); fs.rmSync(dir,{recursive:true,force:true}); }
  }
});

test('a failed prepared-journal write prevents dispatch', async () => {
  const up = await fakeUpstream();
  const dir = tmpdir();
  const blocked = path.join(dir,'not-a-directory');
  fs.writeFileSync(blocked,'blocked');
  const gw = testGateway({jev:null,bounds:{min:'low',max:'high'},upstream:up.url,journalDir:blocked});
  const base = await gw.listen();
  try {
    const response = await fetch(base + '/v1/messages',{method:'POST',headers:{'content-type':'application/json',[GATEWAY_AUTH_HEADER]:TEST_AUTH_TOKEN},body:JSON.stringify(body([u('do not dispatch')]))});
    assert.equal(response.status,502);
    await response.text();
    assert.equal(up.seen.length,0);
  } finally { await gw.close(); up.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a late audit-write failure preserves the response and surfaces degraded coverage', async () => {
  const root = tmpdir(), dir = path.join(root,'journal');
  const notices: string[] = [];
  const up = await fakeUpstream((req,res) => {
    req.resume();
    req.on('end', () => {
      fs.renameSync(dir,path.join(root,'saved-journal'));
      fs.writeFileSync(dir,'blocked');
      res.writeHead(200,{'content-type':'text/event-stream'}).end(SSE_OK);
    });
  });
  const gw = testGateway({jev:null,bounds:{min:'low',max:'high'},upstream:up.url,journalDir:dir,onNotice:(m)=>notices.push(m)});
  const base = await gw.listen();
  try {
    assert.equal(await post(base,body([u('audit write failure')])),SSE_OK);
    assert.ok(notices.some((n)=>n.startsWith('journal write error:')));
    const output = await fetch(base+gw.displayHookPath,{method:'POST',body:JSON.stringify({hook_event_name:'MessageDisplay',session_id:'sess-1',index:0,delta:'Done'})}).then(r=>r.json()) as {systemMessage:string};
    assert.match(output.systemMessage,/audit logging degraded/);
    const { auditJournal } = await import('../src/gateway/audit.ts');
    assert.equal(auditJournal(path.join(root,'saved-journal')).summary.incompleteAttempts,1);
  } finally { await gw.close(); up.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('legacy usage remains identifiable when a new attempt retries an old decision', async () => {
  const { foldJournal } = await import('../src/gateway/journal.ts');
  const record: JournalRecord = {
    decisionId:'legacy',requestFingerprint:'fp',lastUser:0,boundaryHash:'hash',insertions:[],
    routerSnapshot:{v:1},policy:'old',requested:'medium',current:'medium',kind:'task',manual:false,
    turn:0,consecutiveFailures:0,clientEffort:null,profile:null,status:'prepared',at:1,
  };
  const [folded] = foldJournal([
    record,{decisionId:'legacy',status:'completed',at:2,usage:{outputTokens:10}},
    {decisionId:'legacy',attemptId:'new',status:'sent',at:3},
    {decisionId:'legacy',attemptId:'new',status:'completed',at:4,usage:{outputTokens:20},usageComplete:true},
    {decisionId:'legacy',attemptId:'new',status:'completed',at:4,usage:{outputTokens:20},usageComplete:true},
  ]);
  assert.equal(folded.at,1);
  assert.equal(folded.usage!.outputTokens,30);
  assert.equal(folded.legacyUsage!.outputTokens,10);
  assert.equal(folded.attempts!.length,1,'duplicate observations of one attempt are not summed twice');
});

test('journal recovery: a truncated last line (crash mid-append) is skipped; corruption elsewhere still fails', async () => {
  const { readJournalFile } = await import('../src/gateway/journal.ts');
  const dir = tmpdir();
  try {
    const good = JSON.stringify({ decisionId: 'd1', status: 'sent', at: 1 });
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(file, `${good}\n{"decisionId":"d2","sta`);
    assert.equal(readJournalFile(file).length, 1, 'the partial final line from a crash is ignored');
    fs.writeFileSync(file, `{"decisionId":"d2","sta\n${good}\n`);
    assert.throws(() => readJournalFile(file), /Invalid journal JSON at line 1/, 'mid-file corruption is not silently dropped');
    fs.writeFileSync(file, `${good}\n{"decisionId":"d2","sta\n`);
    assert.throws(() => readJournalFile(file), /line 2/, 'a complete (newline-terminated) bad line is corruption, not a crash tail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit --holds explains legacy decisions from their router snapshot', async () => {
  const dir = tmpdir();
  try {
    const j = new Journal(dir);
    const rec = (decisionId: string, kind: 'task' | 'step', issues: unknown[]): JournalRecord => ({
      decisionId, requestFingerprint: decisionId, lastUser: 0, boundaryHash: 'h', insertions: [],
      decision: { kind, effort: 'high', previous: 'high', changed: false, reasons: ['1 unresolved issue(s) → hold high'], source: 'local', jevLatencyMs: 0 },
      routerSnapshot: { v: 2, hold: 0, base: 'medium', state: { clock: 4, issues } }, policy: 'test', requested: 'high', current: 'high',
      kind, manual: false, turn: 4, consecutiveFailures: 0, clientEffort: null, profile: null, status: 'completed', at: 1,
    });
    const issue = { fingerprint: 'abcdef0123456789abcd', command: 'c', environment: false, attempts: 1, tried: ['medium'], lastSeen: 1 };
    j.append('k', rec('d-task', 'task', [issue]));
    j.append('k', rec('d-step', 'step', [issue, { ...issue, fingerprint: 'ffff', environment: true }]));
    // Open issues on a decision that went up anyway did not hold anything.
    j.append('k', { ...rec('d-raise', 'step', [issue]), decision: { kind: 'step', effort: 'high', previous: 'medium', changed: true, reasons: ['failed step → high'], source: 'local', jevLatencyMs: 0 }, current: 'medium' });
    const all = await import('../src/gateway/audit.ts').then((m) => m.auditJournal(dir));
    assert.deepEqual([all.summary.holds.decisions, all.summary.holds.blocked], [2, 1]);
    const { auditJournal, formatAudit } = await import('../src/gateway/audit.ts');
    const held = auditJournal(dir, '', { holds: true });
    assert.deepEqual(held.journals.flatMap((x) => x.decisions.map((d) => d.decisionId)), ['d-step'], 'only step decisions with an open reasoning issue');
    assert.match(formatAudit(held), /open I-abcdef01 · cause unrecorded · last failed 3 steps ago · 1 failed run at medium/);
    assert.match(formatAudit(held), /open I-ffff · .*environment blocker \(never holds\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
