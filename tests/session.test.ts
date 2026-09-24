import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { HookCallbackMatcher, HookEvent, HookInput, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { JevOpusSession, type QueryFn } from '../src/claude/session.ts';
import type { Effort } from '../src/effort.ts';
import type { JevLike, JevQuestion, JevResult } from '../src/jev/client.ts';
import { neutralAnswers, parseAnswers } from '../src/jev/client.ts';
import { EffortRouter } from '../src/router/router.ts';

/** Jev stub answering from a script, in call order. */
function scriptedJev(script: Array<Record<string, unknown>>): JevLike & { states: string[] } {
  const states: string[] = [];
  return {
    enabled: true,
    states,
    async ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
      states.push(state);
      const raw = script.shift();
      return raw
        ? { answers: parseAnswers(raw, questions), failed: false, latencyMs: 5, inputTokens: 50 }
        : { answers: neutralAnswers(questions), failed: true, error: 'script exhausted', latencyMs: 0, inputTokens: 0 };
    },
  };
}

type Step = { tool: string; input: Record<string, unknown>; fail?: string };

interface FakeClaudeOpts {
  /** extra fields merged into each result message, per prompt index (0-based) */
  resultFor?: (promptIndex: number) => Record<string, unknown>;
  /** extra messages emitted after the scripted steps, before the final assistant text */
  emit?: (mk: (id: string, content: unknown[], usage: Record<string, number>, parentToolUseId?: string | null) => SDKMessage) => SDKMessage[];
  /** effort.level reported by the PostToolBatch hook (default: the level in force) */
  hookEffort?: (effort: Effort) => string;
  /** reject the first applyFlagSettings call */
  failApplyOnce?: boolean;
}

/**
 * A stand-in for Claude Code: reads the prompt stream, "calls the API" once per
 * step, fires the real PostToolUseFailure / PostToolBatch hook callbacks the
 * session registered, and tracks the effort level exactly as the CLI would —
 * from the `effort` option and later applyFlagSettings calls.
 */
function fakeClaude(steps: Step[], opts: FakeClaudeOpts = {}) {
  const applied: Effort[] = [];
  const efforts: Effort[] = [];
  let startEffort: Effort | undefined;
  const fn: QueryFn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    let effort = options.effort as Effort;
    startEffort = effort;
    const hooks = (options.hooks ?? {}) as Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    const fire = async (event: HookEvent, input: HookInput) => {
      for (const m of hooks[event] ?? []) for (const h of m.hooks) await h(input, undefined, { signal: new AbortController().signal });
    };
    const base = { session_id: 's', transcript_path: '/t', cwd: '/w' };
    let n = 0;
    let un = 0;
    const mk = (id: string, content: unknown[], usage: Record<string, number>, parentToolUseId: string | null = null): SDKMessage => ({
      type: 'assistant', parent_tool_use_id: parentToolUseId, uuid: `u${++un}`, session_id: 's',
      message: { id, content, usage },
    }) as unknown as SDKMessage;
    const assistant = (content: unknown[]): SDKMessage => {
      efforts.push(effort);
      n++;
      return mk(`msg_${n}`, content, { input_tokens: 10, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50, output_tokens: 20 });
    };
    let applyFailed = false;

    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', model: options.model, claude_code_version: 'fake' } as unknown as SDKMessage;
      let promptIndex = 0;
      for await (const _msg of prompt) {
        for (const [i, s] of steps.entries()) {
          const id = `toolu_${i}`;
          yield assistant([{ type: 'tool_use', id, name: s.tool, input: s.input }]);
          if (s.fail) await fire('PostToolUseFailure', { ...base, hook_event_name: 'PostToolUseFailure', tool_name: s.tool, tool_input: s.input, tool_use_id: id, error: s.fail });
          yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.fail ?? 'ok', is_error: !!s.fail }] } } as unknown as SDKMessage;
          await fire('PostToolBatch', {
            ...base, hook_event_name: 'PostToolBatch', effort: { level: opts.hookEffort ? opts.hookEffort(effort) : effort },
            tool_calls: [{ tool_name: s.tool, tool_input: s.input, tool_use_id: id, tool_response: s.fail ? undefined : { stdout: 'ok', stderr: '' } }],
          });
        }
        for (const m of opts.emit?.(mk) ?? []) yield m;
        yield assistant([{ type: 'text', text: 'All done.' }]);
        yield {
          type: 'result', subtype: 'success', is_error: false, result: 'All done.',
          total_cost_usd: 0.01, num_turns: steps.length + 1, duration_ms: 1234,
          ...(opts.resultFor?.(promptIndex) ?? {}),
        } as unknown as SDKMessage;
        promptIndex++;
      }
    }
    const gen = run();
    return Object.assign(gen, {
      applyFlagSettings: async (s: { effortLevel?: Effort | null }) => {
        if (opts.failApplyOnce && !applyFailed) {
          applyFailed = true;
          throw new Error('applyFlagSettings failed (scripted)');
        }
        if (s.effortLevel) { applied.push(s.effortLevel); effort = s.effortLevel; }
      },
    }) as unknown as Query;
  };
  return { fn, applied, efforts, get startEffort() { return startEffort; } };
}

test('Jev changes effort mid-prompt: failing test → high, hold, finishing → low', async () => {
  // Selective Jev: while the failing test is unresolved the Edit step is decided
  // locally, so the script only needs entries for the task, the failure, and
  // the passing run (a proposed downgrade, which Jev confirms as finishing).
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.8 }, stakes: { noul: 0.2 } },
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.4 }, stuck: { noul: 0.1 } },
    { phase: { choice: 'finishing', confidence: 0.9 }, step_difficulty: { score: 0.5 }, stuck: { noul: 0.05 } },
  ]);
  const claude = fakeClaude([
    { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1: 2 failing' },
    { tool: 'Edit', input: { file_path: 'src/parse.ts' } },
    { tool: 'Bash', input: { command: 'npm test' } },
  ]);
  const session = new JevOpusSession({
    router: new EffortRouter({ jev, bounds: { min: 'low', max: 'high' } }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });

  const report = await session.send('The date parser test fails for leap years, fix it');
  await session.close();

  assert.equal(claude.startEffort, 'medium', 'task routing sets the starting effort');
  assert.deepEqual(claude.applied, ['high', 'low'], 'only real changes are pushed to Claude Code');
  assert.deepEqual(claude.efforts, ['medium', 'high', 'high', 'low'], 'effort per API call');
  assert.deepEqual(report.callEfforts, claude.efforts, 'report matches what the CLI used');
  assert.deepEqual(report.observedEfforts, ['medium', 'high', 'high']);
  assert.equal(report.decisions.length, 4);
  assert.match(jev.states[1]!, /npm test → FAILED: Exit code 1/);
  assert.match(jev.states[1]!, /consecutive failed tool calls: 1/);
  assert.equal(report.usage.cacheRead, 1000 + 2000 + 3000 + 4000);
});

test('pinned effort never routes and never changes', async () => {
  const jev = scriptedJev([]);
  const claude = fakeClaude([{ tool: 'Read', input: { file_path: 'a' } }, { tool: 'Bash', input: { command: 'ls' }, fail: 'boom' }]);
  const session = new JevOpusSession({
    router: new EffortRouter({ jev, bounds: { min: 'low', max: 'high' }, pinned: 'high' }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });
  const report = await session.send('anything');
  await session.close();
  assert.equal(jev.states.length, 0);
  assert.deepEqual(claude.applied, []);
  assert.deepEqual(report.callEfforts, ['high', 'high', 'high']);
});

test('Jev outage falls back to heuristics and still escalates on failures', async () => {
  const jev = scriptedJev([]); // every call fails
  const claude = fakeClaude([
    { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1' },
    { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1' },
    { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1' },
  ]);
  const session = new JevOpusSession({
    router: new EffortRouter({ jev, bounds: { min: 'low', max: 'high' } }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });
  const report = await session.send('fix the failing build');
  await session.close();
  assert.ok(report.decisions.every((d) => d.source === 'heuristic'));
  assert.equal(report.callEfforts.at(-1), 'high');
  assert.ok(report.callEfforts.every((e) => e === 'low' || e === 'medium' || e === 'high'), 'respects the high ceiling');
});

test('block-level assistant usage keeps the latest report per message id', async () => {
  const claude = fakeClaude([], {
    emit: (mk) => [
      // one API call streamed as two block-level messages sharing message.id
      mk('msg_blk', [{ type: 'thinking', thinking: 'hmm' }], { input_tokens: 10, output_tokens: 0 }),
      mk('msg_blk', [{ type: 'text', text: 'done' }], { input_tokens: 10, output_tokens: 100 }),
    ],
  });
  const session = new JevOpusSession({
    router: new EffortRouter({ jev: null, bounds: { min: 'low', max: 'high' } }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });
  const report = await session.send('hello');
  await session.close();
  const blk = report.calls.find((c) => c.outputTokens === 100);
  assert.ok(blk, 'the call record exists');
  assert.equal(report.calls.length, 2, 'one record per message id, not per block');
  assert.equal(report.calls[0]!.outputTokens, 100, 'latest block usage wins, not the first');
  assert.equal(report.usage.output, 120, 'usage sums latest per-call usage');
  assert.equal(report.scope.tokens, 'main-thread-calls', 'no modelUsage → per-call coverage is labelled');
  assert.equal(report.scope.costUsd, 'task-delta');
});

test('task cost/tokens are deltas of the cumulative session counters, including subagents', async () => {
  const usage = (inputTokens: number, outputTokens: number, costUSD: number) => ({
    main: { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD },
    helper: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
  });
  const claude = fakeClaude([], {
    emit: (mk) => [mk('msg_sub', [{ type: 'text', text: 'subagent chunk' }], { input_tokens: 5000, output_tokens: 400 }, 'toolu_task')],
    resultFor: (i) => [
      { total_cost_usd: 0.10, modelUsage: usage(6010, 525, 0.10) },
      { total_cost_usd: 0.30, modelUsage: usage(12010, 1050, 0.30) },
      { total_cost_usd: 0.05, modelUsage: usage(505, 55, 0.05) },
    ][i] ?? {},
  });
  const session = new JevOpusSession({
    router: new EffortRouter({ jev: null, bounds: { min: 'low', max: 'high' } }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });

  const r1 = await session.send('first task');
  assert.equal(r1.costUsd, 0.10, 'first task: delta from a zero baseline');
  assert.equal(r1.usage.input, 6020, 'modelUsage summed across models incl. subagent spend');
  assert.equal(r1.usage.output, 530);
  assert.equal(r1.calls.length, 1, 'subagent traffic is not a main-thread call');
  assert.equal(r1.scope.tokens, 'task-delta');
  assert.equal(r1.sessionTotals.costUsd, 0.10);
  assert.equal(r1.counterReset, false);

  const r2 = await session.send('second task');
  assert.ok(Math.abs(r2.costUsd - 0.20) < 1e-9, `delta of $0.10 → $0.30 is $0.20, not $0.30 (got ${r2.costUsd})`);
  assert.equal(r2.usage.input, 6000);
  assert.equal(r2.sessionTotals.costUsd, 0.30, 'session total is the raw cumulative counter');
  assert.equal(r2.counterReset, false);

  const r3 = await session.send('third task');
  assert.equal(r3.costUsd, 0.05, 'counter went backwards → new value is the delta');
  assert.equal(r3.counterReset, true, 'the epoch reset is flagged');
  assert.equal(r3.usage.input, 515);
  assert.equal(r3.sessionTotals.costUsd, 0.05);
  await session.close();
});

test('requested, applied, and observed effort stay distinct', async () => {
  const claude = fakeClaude([{ tool: 'Read', input: { file_path: 'a' } }], { hookEffort: () => 'low' });
  const session = new JevOpusSession({
    router: new EffortRouter({ jev: null, bounds: { min: 'low', max: 'high' }, pinned: 'high' }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });
  const report = await session.send('anything');
  await session.close();
  assert.deepEqual(report.callEfforts, ['high', 'high'], 'requested efforts per call');
  assert.equal(report.calls[0]!.requested, 'high');
  assert.equal(report.calls[0]!.applied, true, 'the start option counts as applied');
  assert.equal(report.calls[0]!.observed, 'low', 'the hook reported what the turn actually ran at');
  assert.equal(report.calls[1]!.observed, undefined, 'no batch hook fired after the final call');
  assert.deepEqual(report.observedEfforts, ['low']);
});

test('a rejected applyFlagSettings marks calls requested-but-not-applied, then recovers', async () => {
  const claude = fakeClaude(
    [
      { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1' },
      { tool: 'Bash', input: { command: 'npm test' }, fail: 'Exit code 1' },
    ],
    { failApplyOnce: true },
  );
  const session = new JevOpusSession({
    router: new EffortRouter({ jev: null, bounds: { min: 'low', max: 'high' } }),
    cwd: '/w', model: 'claude-opus-5-5', env: {}, permissionMode: 'acceptEdits', settingSources: [], queryFn: claude.fn,
  });
  const report = await session.send('fix the failing build');
  await session.close();
  assert.equal(claude.applied.length, 1, 'the second apply attempt went through');
  const unapplied = report.calls.filter((c) => !c.applied);
  assert.equal(unapplied.length, 1);
  assert.equal(unapplied[0]!.requested, 'high', 'the router asked for high but it was never confirmed');
  assert.equal(report.calls.at(-1)!.applied, true, 'the retry applied the level before the next call');
  assert.ok(report.decisions.every((d) => d.effort), 'decisions are still recorded when apply fails');
});

test('--json prints only parseable JSON on stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-opus-cli-'));
  try {
    const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
    const res = spawnSync(process.execPath, [cli, '--json', '--no-jev', '--route-only', 'fix the bug'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', JEV_OPUS_CONFIG_DIR: dir, NO_COLOR: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout) as { kind?: string; effort?: string };
    assert.equal(parsed.kind, 'task');
    assert.ok(parsed.effort);
    assert.ok(!res.stdout.includes('\x1b'), 'no colored output on stdout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
