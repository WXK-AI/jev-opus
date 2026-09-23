import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JevGateway } from '../src/gateway/server.ts';
import { addBeta, applyInsertions, effortInForce, lastToolRound, prefixHashes, userText, type Message } from '../src/gateway/transcript.ts';
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

async function fakeUpstream(): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url?.startsWith('/v1/models')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 5);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14', 'x-claude-code-session-id': 'sess-1', authorization: 'Bearer secret', ...headers },
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

test('transcript helpers', () => {
  assert.equal(userText(u('<system-reminder>ignore me</system-reminder>fix the bug')), 'fix the bug');
  assert.equal(addBeta('oauth-2025-04-20'), 'oauth-2025-04-20,mid-conversation-output-config-2026-07-01');
  assert.equal(addBeta('per-turn-control-2026-07-01'), 'per-turn-control-2026-07-01');
  const msgs = [u('go'), a('t1', 'npm test'), r('t1', 'Exit code 1\n2 failing', true)];
  const round = lastToolRound(msgs);
  assert.equal(round.batch[0]?.failed, true);
  assert.equal(round.batch[0]?.summary, 'npm test');
  const h = prefixHashes(msgs);
  const out = applyInsertions(msgs, [{ index: 2, effort: 'high', prefixHash: h[2]! }, { index: 0, effort: 'low', prefixHash: h[0]! }]);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'system', 'user']);
  assert.equal(effortInForce(out, 'medium'), 'high');
  assert.equal(effortInForce(msgs, undefined), 'medium');
});

test('gateway: routes jev model, replays insertions byte-identically, passes secrets through', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.0 }, stakes: { noul: 0.1 } }, // → medium floor
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.5 }, stuck: { noul: 0.1 } }, // → high
    { phase: { choice: 'verifying', confidence: 0.9 }, step_difficulty: { score: 1 }, stuck: { noul: 0.1 } }, // hold high
  ]);
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url });
  const base = await gw.listen();
  try {
    const body = (messages: Message[]) => ({ model: 'jev/claude-opus-5-5', stream: true, tools, output_config: { effort: 'low' }, messages });
    const m1 = [u('the date test fails, fix it')];
    const sse = await post(base, body(m1));
    assert.match(sse, /message_stop/, 'SSE streamed through');
    let s = up.seen.at(-1)!;
    assert.equal(s.body!.model, 'claude-opus-5-5', 'jev/ prefix stripped');
    assert.equal(s.headers.authorization, 'Bearer secret', 'credential forwarded unchanged');
    assert.match(String(s.headers['anthropic-beta']), /oauth-2025-04-20.*mid-conversation-output-config-2026-07-01/);
    const sent1 = s.body!.messages as Message[];
    assert.deepEqual(sent1[0], { role: 'system', content: [], output_config: { effort: 'medium' } }, 'task effort inserted before the prompt');
    assert.deepEqual((s.body!.output_config as { effort: string }).effort, 'low', 'top-level effort untouched (cache prefix stable)');

    const m2 = [...m1, a('t1', 'npm test'), r('t1', 'Exit code 1: 2 failing', true)];
    await post(base, body(m2));
    const sent2 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sent2.slice(0, sent1.length), sent1, 'earlier request replayed exactly: prefix identical');
    assert.deepEqual(sent2.at(-2), { role: 'system', content: [], output_config: { effort: 'high' } }, 'failure → high before the tool result');

    await post(base, body(m2)); // client retry of the same request
    assert.equal(jev.calls, 2, 'retry does not ask Jev again');
    assert.deepEqual(up.seen.at(-1)!.body!.messages, sent2, 'retry replays the same insertions');

    const m3 = [...m2, a('t2', 'npm test'), r('t2', 'PASS 3 tests')];
    await post(base, body(m3));
    const sent3 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sent3.slice(0, sent2.length), sent2, 'prefix identical again');
    assert.equal(sent3.length, sent2.length + 2, 'hysteresis holds high: no new insertion');

    // /rewind to before the failing step: stale insertion is dropped, new branch re-routed
    const m4 = [...m1, a('t9', 'ls'), r('t9', 'dates.js')];
    await post(base, body(m4));
    const sent4 = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(sent4.filter((m) => m.role === 'system').some((m) => m.output_config?.effort === 'high' && sent4.indexOf(m) === 2), false);
    assert.deepEqual(sent4[0], sent1[0], 'insertion on the shared prefix survives');
  } finally {
    await gw.close();
    up.close();
  }
});

test('gateway: other models, side requests without tools, and /v1/models', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([]);
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url });
  const base = await gw.listen();
  try {
    const plain = { model: 'claude-opus-5-5', tools, messages: [u('hi')] };
    await post(base, plain);
    assert.deepEqual(up.seen.at(-1)!.body, plain, 'non-jev request forwarded verbatim');
    assert.equal(up.seen.at(-1)!.headers['anthropic-beta'], 'oauth-2025-04-20,interleaved-thinking-2025-05-14');

    await post(base, { model: 'jev/claude-opus-5-5', messages: [u('write a title for this chat')] });
    const side = up.seen.at(-1)!.body!;
    assert.equal(side.model, 'claude-opus-5-5');
    assert.equal((side.messages as Message[]).length, 1, 'no routing for tool-less side requests');
    assert.equal(jev.calls, 0);

    const models = (await (await fetch(`${base}/v1/models?limit=1000`)).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map((m) => m.id), ['jev/claude-opus-5-5', 'claude-opus-5-5']);
  } finally {
    await gw.close();
    up.close();
  }
});

test('gateway: real Claude Code shape: trailing per-turn statement, re-serialized history, moving cache_control', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }, // low
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.5 }, stuck: { noul: 0.1 } }, // high
  ]);
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url });
  const base = await gw.listen();
  try {
    const body = (messages: Message[]) => ({ model: 'jev/claude-opus-5-5', tools, output_config: { effort: 'medium' }, messages });
    const cc = (content: unknown): Message => ({ role: 'system', content, output_config: { effort: 'medium' } });
    const prompt: Message = { role: 'user', content: [{ type: 'text', text: 'rename x to y', cache_control: { type: 'ephemeral' } }] };
    // Request 1, as Claude Code sends it: the prompt, then its own per-turn statement.
    await post(base, body([prompt, cc([{ type: 'text', text: 'env info' }])]));
    const sent1 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sent1.map((m) => m.role), ['system', 'user', 'system', 'system']);
    assert.equal(sent1[0]!.output_config?.effort, 'low', 'ours before the prompt');
    assert.equal(sent1[3]!.output_config?.effort, 'low', 'and restated after the trailing client statement');

    // Request 2: history re-serialized (string content), breakpoint moved to the newest message.
    const prompt2: Message = { role: 'user', content: [{ type: 'text', text: 'rename x to y' }] };
    const m2 = [prompt2, cc('env info'), a('t1', 'npm test'), { ...r('t1', 'Exit code 1', true), content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1', is_error: true, cache_control: { type: 'ephemeral' } }] }];
    await post(base, body(m2));
    const sent2 = up.seen.at(-1)!.body!.messages as Message[];
    assert.deepEqual(sent2.map((m) => `${m.role}${m.output_config?.effort ? ':' + m.output_config.effort : ''}`),
      ['system:low', 'user', 'system:medium', 'system:low', 'assistant', 'system:high', 'user'], 'earlier insertions survive re-serialization; failure → high');
    assert.equal(jev.calls, 2);
  } finally {
    await gw.close();
    up.close();
  }
});

test('gateway: a changed client effort (the user ran /effort) pauses routing until the next prompt', async () => {
  const up = await fakeUpstream();
  const jev = scriptedJev([
    { task_type: { choice: 'code_small', confidence: 0.9 }, difficulty: { score: 0.2 }, stakes: { noul: 0.1 } }, // low
  ]);
  const gw = new JevGateway({ jev, bounds: { min: 'low', max: 'high' }, upstream: up.url });
  const base = await gw.listen();
  try {
    const body = (messages: Message[]) => ({ model: 'jev/claude-opus-5-5', tools, messages });
    const stmt = (effort: string): Message => ({ role: 'system', content: [], output_config: { effort } });
    const m1 = [u('rename x to y'), stmt('medium')];
    await post(base, body(m1));
    const m2 = [...m1, a('t1', 'grep -r x'), stmt('high'), r('t1', 'a.js:1')];
    await post(base, body(m2));
    assert.equal(jev.calls, 1, 'no step routing after the user set effort by hand');
    const sent = up.seen.at(-1)!.body!.messages as Message[];
    assert.equal(effortInForce(sent, undefined), 'high', "the user's level stays in force");
  } finally {
    await gw.close();
    up.close();
  }
});
