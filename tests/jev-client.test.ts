import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JevClient, parseAnswers } from '../src/jev/client.ts';
import { STEP_QUESTIONS, TASK_QUESTIONS } from '../src/router/questions.ts';

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

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() });
    });
  });
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
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'jev-latest',
        answers: { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.2, confidence: 0.7 }, stuck: { noul: 0.2 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      }));
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
    assert.equal(jev.inputTokens, 120);
  } finally {
    srv.close();
  }
});

test('JevClient never throws: HTTP errors yield neutral answers with failed=true', async () => {
  const srv = await server((_req, res) => { res.statusCode = 401; res.end('bad key'); });
  try {
    const jev = new JevClient({ apiKey: 'apikey_bad', baseUrl: srv.url });
    const r = await jev.ask('s', STEP_QUESTIONS);
    assert.equal(r.failed, true);
    assert.match(r.error ?? '', /401/);
    assert.equal(r.answers.phase?.kind, 'choice');
  } finally {
    srv.close();
  }
});

test('JevClient without a key is disabled and fails fast', async () => {
  const jev = new JevClient({ apiKey: '' });
  assert.equal(jev.enabled, false);
  const r = await jev.ask('s', TASK_QUESTIONS);
  assert.equal(r.failed, true);
});

test('JevClient via OpenRouter pins the TypeSafe provider', async () => {
  let body: Record<string, unknown> = {};
  const srv = await server((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { stuck: { noul: 0.9 } }, usage: { input_tokens: 5 } }));
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
