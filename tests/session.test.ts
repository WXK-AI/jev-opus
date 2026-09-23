import assert from 'node:assert/strict';
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

/**
 * A stand-in for Claude Code: reads the prompt stream, "calls the API" once per
 * step, fires the real PostToolUseFailure / PostToolBatch hook callbacks the
 * session registered, and tracks the effort level exactly as the CLI would —
 * from the `effort` option and later applyFlagSettings calls.
 */
function fakeClaude(steps: Step[]) {
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
    const assistant = (content: unknown[]): SDKMessage => {
      efforts.push(effort);
      n++;
      return {
        type: 'assistant', parent_tool_use_id: null, uuid: `u${n}`, session_id: 's',
        message: { id: `msg_${n}`, content, usage: { input_tokens: 10, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50, output_tokens: 20 } },
      } as unknown as SDKMessage;
    };

    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', model: options.model, claude_code_version: 'fake' } as unknown as SDKMessage;
      for await (const _msg of prompt) {
        for (const [i, s] of steps.entries()) {
          const id = `toolu_${i}`;
          yield assistant([{ type: 'tool_use', id, name: s.tool, input: s.input }]);
          if (s.fail) await fire('PostToolUseFailure', { ...base, hook_event_name: 'PostToolUseFailure', tool_name: s.tool, tool_input: s.input, tool_use_id: id, error: s.fail });
          yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.fail ?? 'ok', is_error: !!s.fail }] } } as unknown as SDKMessage;
          await fire('PostToolBatch', {
            ...base, hook_event_name: 'PostToolBatch', effort: { level: effort },
            tool_calls: [{ tool_name: s.tool, tool_input: s.input, tool_use_id: id, tool_response: s.fail ? undefined : { stdout: 'ok', stderr: '' } }],
          });
        }
        yield assistant([{ type: 'text', text: 'All done.' }]);
        yield { type: 'result', subtype: 'success', is_error: false, result: 'All done.', total_cost_usd: 0.01, num_turns: steps.length + 1, duration_ms: 1234 } as unknown as SDKMessage;
      }
    }
    const gen = run();
    return Object.assign(gen, {
      applyFlagSettings: async (s: { effortLevel?: Effort | null }) => {
        if (s.effortLevel) { applied.push(s.effortLevel); effort = s.effortLevel; }
      },
    }) as unknown as Query;
  };
  return { fn, applied, efforts, get startEffort() { return startEffort; } };
}

test('Jev changes effort mid-prompt: failing test → high, hold, finishing → low', async () => {
  const jev = scriptedJev([
    { task_type: { choice: 'debugging', confidence: 0.9 }, difficulty: { score: 1.8 }, stakes: { noul: 0.2 } },
    { phase: { choice: 'diagnosing', confidence: 0.9 }, step_difficulty: { score: 3.4 }, stuck: { noul: 0.1 } },
    { phase: { choice: 'verifying', confidence: 0.8 }, step_difficulty: { score: 1.0 }, stuck: { noul: 0.1 } },
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
