import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JevClient, parseAnswers, validateAnswers } from '../src/jev/client.ts';
import { STEP_QUESTIONS, TASK_QUESTIONS } from '../src/router/questions.ts';

// Legacy lenient parser — still exported for scripted JevLike stubs elsewhere.
test('parseAnswers clamps values and rejects unknown choices', () => {
  const a = parseAnswers(
    {
      task_type: { choice: 'not-a-type', confidence: 3 },
      difficulty: { score: 9, confidence: 0.5 },
      stakes: { noul: -1 },
    },
    TASK_QUESTIONS,
  );
  assert.deepEqual(a.task_type, { kind: 'choice', choice: 'chat', confidence: 1, probabilities: {} });
  assert.equal(a.difficulty?.kind === 'score' && a.difficulty.score, 4);
  assert.equal(a.stakes?.kind === 'noul' && a.stakes.p, 0);
});

test('validateAnswers: absent entries are missing and excluded from answers', () => {
  const { answers, signals } = validateAnswers({}, TASK_QUESTIONS);
  assert.deepEqual(signals, { task_type: 'missing', difficulty: 'missing', stakes: 'missing' });
  assert.deepEqual(answers, {});
  // null/absent raw payload → every question missing
  const none = validateAnswers(undefined, TASK_QUESTIONS);
  assert.deepEqual(none.signals, signals);
});

test('validateAnswers rejects instead of clamping: unknown choice, out-of-range score, out-of-range noul', () => {
  const { answers, signals } = validateAnswers(
    {
      task_type: { choice: 'not-a-type', confidence: 0.9 },
      difficulty: { score: 9, confidence: 0.5 },
      stakes: { noul: 0.3 },
    },
    TASK_QUESTIONS,
  );
  assert.deepEqual(signals, { task_type: 'invalid', difficulty: 'invalid', stakes: 'valid' });
  assert.equal(answers.task_type, undefined); // never replaced by the first category
  assert.equal(answers.difficulty, undefined); // never clamped to 4
  assert.deepEqual(answers.stakes, { kind: 'noul', p: 0.3 });

  const bad = validateAnswers(
    { stuck: { noul: -1 }, step_difficulty: { score: 'hard' }, phase: 'exploring' },
    STEP_QUESTIONS,
  );
  assert.equal(bad.signals.stuck, 'invalid'); // noul outside 0..1
  assert.equal(bad.signals.step_difficulty, 'invalid'); // non-numeric score
  assert.equal(bad.signals.phase, 'invalid'); // present but not an object
});

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() });
    });
  });
}

function json(res: http.ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

test('JevClient sends the System-1 wire format and parses answers', async () => {
  let body: Record<string, unknown> = {};
  let auth = '';
  const srv = await server((req, res) => {
    auth = req.headers.authorization ?? '';
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      body = JSON.parse(raw);
      json(res, {
        model: 'jev-latest',
        answers: { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.2, confidence: 0.7 }, stuck: { noul: 0.2 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      });
    });
  });
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url, model: 'jev-latest' });
    const r = await jev.ask('state text', STEP_QUESTIONS);
    assert.equal(r.failed, false);
    assert.equal(auth, 'Bearer apikey_test');
    assert.equal(body.state, 'state text');
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body.questions as object), ['phase', 'step_difficulty', 'stuck']);
    assert.equal(r.answers.phase?.kind === 'choice' && r.answers.phase.choice, 'diagnosing');
    assert.deepEqual(r.signals, { phase: 'valid', step_difficulty: 'valid', stuck: 'valid' });
    assert.equal(jev.inputTokens, 120);
  } finally {
    srv.close();
  }
});

test('JevClient: HTTP 200 with empty answers fails — every signal missing, no stand-ins', async () => {
  const srv = await server((_req, res) => json(res, { model: 'jev-latest', answers: {}, usage: {} }));
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url });
    const r = await jev.ask('s', TASK_QUESTIONS);
    assert.equal(r.failed, true);
    assert.deepEqual(r.signals, { task_type: 'missing', difficulty: 'missing', stakes: 'missing' });
    assert.deepEqual(r.answers, {});
  } finally {
    srv.close();
  }
});

test('JevClient: partial validity keeps valid answers, marks the rest, and does not fail', async () => {
  const srv = await server((_req, res) =>
    json(res, {
      answers: {
        phase: { choice: 'bogus-phase', confidence: 0.99 },
        step_difficulty: { score: 2, confidence: 0.6 },
        stuck: { noul: 0.5 },
      },
    }),
  );
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url });
    const r = await jev.ask('s', STEP_QUESTIONS);
    assert.equal(r.failed, false);
    assert.deepEqual(r.signals, { phase: 'invalid', step_difficulty: 'valid', stuck: 'valid' });
    assert.equal(r.answers.phase, undefined);
    assert.equal(r.answers.step_difficulty?.kind === 'score' && r.answers.step_difficulty.score, 2);
  } finally {
    srv.close();
  }
});

test('JevClient never throws: HTTP errors fail with empty answers and missing signals', async () => {
  const srv = await server((_req, res) => { res.statusCode = 401; res.end('bad key'); });
  try {
    const jev = new JevClient({ apiKey: 'apikey_bad', baseUrl: srv.url });
    const r = await jev.ask('s', STEP_QUESTIONS);
    assert.equal(r.failed, true);
    assert.match(r.error ?? '', /401/);
    assert.deepEqual(r.answers, {});
    assert.deepEqual(r.signals, { phase: 'missing', step_difficulty: 'missing', stuck: 'missing' });
  } finally {
    srv.close();
  }
});

test('JevClient enforces one overall deadline across the whole ask', async () => {
  const srv = await server((_req, res) => setTimeout(() => json(res, { answers: {} }), 500));
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url, deadlineMs: 80, retries: 2 });
    const r = await jev.ask('s', TASK_QUESTIONS);
    assert.equal(r.failed, true);
    assert.ok(r.latencyMs < 450, `expected the deadline to cut the call short, took ${r.latencyMs}ms`);
    assert.match(r.error ?? '', /deadline|abort/i);
  } finally {
    srv.close();
  }
});

test('JevClient honors a caller AbortSignal', async () => {
  let hits = 0;
  const srv = await server((_req, res) => { hits++; setTimeout(() => json(res, { answers: {} }), 200); });
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url, deadlineMs: 5_000 });
    const ac = new AbortController();
    ac.abort();
    const r = await jev.ask('s', TASK_QUESTIONS, { signal: ac.signal });
    assert.equal(r.failed, true);
    assert.equal(hits, 0); // aborted before the fetch went out
  } finally {
    srv.close();
  }
});

test('JevClient retries opt-in attempts still succeed inside the deadline', async () => {
  let hits = 0;
  const srv = await server((_req, res) => {
    hits++;
    if (hits < 3) { res.statusCode = 500; res.end('err'); return; }
    json(res, { answers: { stuck: { noul: 0.4 } }, usage: { input_tokens: 3 } });
  });
  try {
    const jev = new JevClient({ apiKey: 'apikey_test', baseUrl: srv.url, retries: 2, deadlineMs: 5_000 });
    const r = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    assert.equal(hits, 3);
    assert.equal(r.failed, false);
    assert.equal(r.answers.stuck?.kind === 'noul' && r.answers.stuck.p, 0.4);
  } finally {
    srv.close();
  }
});

test('JevClient circuit breaker opens after N failures, skips fetch while open, probes after cooldown', async () => {
  let hits = 0;
  const srv = await server((_req, res) => { hits++; res.statusCode = 500; res.end('err'); });
  try {
    let t = 10_000;
    const jev = new JevClient({
      apiKey: 'apikey_test',
      baseUrl: srv.url,
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      now: () => t,
    });
    for (let i = 0; i < 3; i++) {
      const r = await jev.ask('s', TASK_QUESTIONS);
      assert.equal(r.failed, true);
      assert.equal(r.circuitOpen, undefined);
    }
    assert.equal(hits, 3);

    // Open: no fetch happens.
    const open = await jev.ask('s', TASK_QUESTIONS);
    assert.equal(open.failed, true);
    assert.equal(open.circuitOpen, true);
    assert.equal(open.error, 'circuit open');
    assert.equal(hits, 3);

    // Cooldown elapsed: one real probe goes out, fails, and re-opens.
    t += 30_001;
    const probe = await jev.ask('s', TASK_QUESTIONS);
    assert.equal(probe.failed, true);
    assert.equal(probe.circuitOpen, undefined);
    assert.equal(hits, 4);

    const again = await jev.ask('s', TASK_QUESTIONS);
    assert.equal(again.circuitOpen, true);
    assert.equal(hits, 4);
  } finally {
    srv.close();
  }
});

test('JevClient circuit breaker closes when the recovery probe succeeds', async () => {
  let hits = 0;
  const srv = await server((_req, res) => {
    hits++;
    if (hits <= 3) { res.statusCode = 500; res.end('err'); return; }
    json(res, { answers: { stuck: { noul: 0.1 } } });
  });
  try {
    let t = 10_000;
    const jev = new JevClient({
      apiKey: 'apikey_test',
      baseUrl: srv.url,
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      now: () => t,
    });
    for (let i = 0; i < 3; i++) await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    const open = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    assert.equal(open.circuitOpen, true);
    assert.equal(hits, 3);

    t += 30_001;
    const probe = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    assert.equal(probe.failed, false);
    assert.equal(hits, 4);

    // Closed again: calls flow normally.
    const r = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    assert.equal(r.failed, false);
    assert.equal(hits, 5);
  } finally {
    srv.close();
  }
});

test('JevClient without a key is disabled and fails fast', async () => {
  const jev = new JevClient({ apiKey: '' });
  assert.equal(jev.enabled, false);
  const r = await jev.ask('s', TASK_QUESTIONS);
  assert.equal(r.failed, true);
  assert.deepEqual(r.signals, { task_type: 'missing', difficulty: 'missing', stakes: 'missing' });
});

test('JevClient via OpenRouter pins the TypeSafe provider', async () => {
  let body: Record<string, unknown> = {};
  const srv = await server((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      body = JSON.parse(raw);
      json(res, { model: 'typesafe/jev-1.13', answers: { stuck: { noul: 0.9 } }, usage: { input_tokens: 5 } });
    });
  });
  try {
    const jev = new JevClient({ provider: 'openrouter', apiKey: 'sk-or-test', baseUrl: srv.url, model: 'typesafe/jev-1.13' });
    const r = await jev.ask('s', { stuck: STEP_QUESTIONS.stuck });
    assert.equal(r.failed, false);
    assert.equal(body.model, 'typesafe/jev-1.13');
    assert.deepEqual(body.provider, { only: ['typesafe'], allow_fallbacks: false });
    assert.equal(r.answers.stuck?.kind === 'noul' && r.answers.stuck.p, 0.9);
  } finally {
    srv.close();
  }
});
