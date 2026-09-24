import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Journal, type JournalRecord } from '../src/gateway/journal.ts';
import { JevGateway } from '../src/gateway/server.ts';
import { prefixHashes, type Message } from '../src/gateway/transcript.ts';
import { neutralAnswers, parseAnswers, type JevLike, type JevQuestion, type JevResult } from '../src/jev/client.ts';

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
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', authorization: 'Bearer secret', ...headers },
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    await post(base, body(m1));
    const mOk = [...m1, a('t1', 'ls'), r('t1', 'dates.js')];
    await post(base, body(mOk));
    const sentOk = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sentOk[3], { role: 'system', content: [], output_config: { effort: 'low' } }, 'a successful step de-escalates to low');

    // Same last-user index, different fingerprint: the tool result changed from success to failure.
    const mFail = [...m1, a('t1', 'ls'), r('t1', 'Exit code 1: 2 failing', true)];
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

test('thread eviction rebuilds from the journal: maxThreads 1 keeps the original insertion', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } }, // A task → medium
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 3.0 }, stakes: { noul: 0.2 } }, // B task → high
    { phase: { choice: 'verifying', confidence: 0.9 }, step_difficulty: { score: 1.0 }, stuck: { noul: 0.1 } }, // A step
  ]);
  const dir = tmpdir();
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, maxThreads: 1 });
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
  const gw1 = new JevGateway({ jev: jev1, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base1 = await gw1.listen();
  await post(base1, body(m1));
  const sent1 = up.seen.at(-1)!.body!.messages as Message[];
  await gw1.close();

  const jev2 = scriptedJev([
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.5 }, stuck: { noul: 0.1 } }, // → high
  ]);
  const gw2 = new JevGateway({ jev: jev2, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
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

test('telemetry: SSE usage and stop_reason are journaled as completed', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } },
  ]);
  const dir = tmpdir();
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: jsonUp.url, journalDir: dir });
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
  const gw2 = new JevGateway({
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
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-2' },
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
  const base = await gw.listen();
  try {
    const m1 = [u('rename x to y')];
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1' },
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, onDecision: () => { decisions++; } });
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir });
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
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url, journalDir: dir, onDecision: (_s, d) => decided.push(d.kind) });
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
