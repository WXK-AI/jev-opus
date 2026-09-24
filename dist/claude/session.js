import { query as sdkQuery, } from '@anthropic-ai/claude-agent-sdk';
import { describeToolInput, looksFailed, stringifyResult, testRunner } from './describe.js';
/** Push-driven AsyncIterable feeding user prompts into Claude Code's streaming input. */
class InputQueue {
    items = [];
    waiters = [];
    closed = false;
    push(item) {
        const w = this.waiters.shift();
        if (w)
            w({ value: item, done: false });
        else
            this.items.push(item);
    }
    close() {
        this.closed = true;
        for (const w of this.waiters.splice(0))
            w({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const item = this.items.shift();
                if (item)
                    return Promise.resolve({ value: item, done: false });
                if (this.closed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);
export class JevOpusSession {
    opts;
    input = new InputQueue();
    q = null;
    pump = null;
    /** latest effort the router decided (requested) */
    effort = null;
    /** latest effort confirmed pushed to Claude Code (start option or resolved applyFlagSettings) */
    appliedEffort = null;
    task = null;
    toolNames = new Map();
    lastResult = '';
    ended = null;
    /** cumulative session counters carried by the last result — task numbers are deltas of these */
    lastTotals = {
        costUsd: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    };
    constructor(opts) {
        this.opts = opts;
    }
    get currentEffort() {
        return this.effort;
    }
    /** Route the prompt with Jev, set effort, run it to completion. */
    async send(prompt) {
        if (this.ended)
            throw this.ended;
        if (this.task)
            throw new Error('a prompt is already running');
        const { router, observer } = this.opts;
        const decision = await router.routeTask(prompt, this.effort, this.lastResult || undefined);
        observer?.onDecision?.(decision);
        this.opts.trace?.({ event: 'decision', ...decision });
        this.effort = decision.effort;
        if (!this.q)
            this.start(decision.effort);
        else if (decision.effort !== this.appliedEffort) {
            await this.q.applyFlagSettings({ effortLevel: decision.effort });
            this.appliedEffort = decision.effort;
        }
        const done = new Promise((resolve, reject) => {
            this.task = {
                prompt,
                profile: decision.profile ?? router.lastProfileFallback(prompt),
                turn: 0,
                consecutiveFailures: 0,
                assistantNote: '',
                trajectory: [],
                failures: new Map(),
                decisions: [decision],
                calls: new Map(),
                lastCall: null,
                observedEfforts: [],
                resolve,
                reject,
            };
        });
        this.input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
        return done;
    }
    /** Pin/unpin effort mid-session (REPL /pin, /auto). Applies immediately. */
    async setPinned(effort) {
        this.opts.router.pinned = effort;
        if (!effort || !this.q)
            return;
        this.effort = effort;
        if (effort !== this.appliedEffort) {
            await this.q.applyFlagSettings({ effortLevel: effort });
            this.appliedEffort = effort;
        }
    }
    async close() {
        this.input.close();
        try {
            await this.pump;
        }
        catch {
            // already surfaced to the running task
        }
    }
    start(initialEffort) {
        const o = this.opts;
        const hook = (fn) => async (input) => {
            try {
                await fn(input);
            }
            catch (err) {
                o.observer?.onNotice?.(`hook error: ${err.message}`);
            }
            return {};
        };
        const options = {
            cwd: o.cwd,
            env: o.env,
            model: o.model,
            effort: initialEffort,
            thinking: { type: 'adaptive' },
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            settingSources: o.settingSources,
            permissionMode: o.permissionMode,
            allowDangerouslySkipPermissions: o.permissionMode === 'bypassPermissions',
            canUseTool: o.canUseTool,
            maxTurns: o.maxTurns,
            pathToClaudeCodeExecutable: o.claudePath,
            hooks: {
                PostToolUseFailure: [{ hooks: [hook(async (i) => this.onToolFailure(i))] }],
                PostToolBatch: [{ hooks: [hook(async (i) => this.onToolBatch(i))], timeout: 60 }],
            },
        };
        this.q = (o.queryFn ?? sdkQuery)({ prompt: this.input, options });
        this.appliedEffort = initialEffort; // the start option is applied by definition
        this.pump = this.consume(this.q);
    }
    async consume(q) {
        try {
            for await (const m of q)
                this.handle(m);
            this.ended = new Error('Claude Code session ended');
        }
        catch (err) {
            this.ended = err;
        }
        const t = this.task;
        this.task = null;
        t?.reject(this.ended);
    }
    handle(m) {
        const o = this.opts;
        const t = this.task;
        if (m.type === 'system' && m.subtype === 'init') {
            o.observer?.onInit?.({ model: m.model, claudeVersion: m.claude_code_version });
            if (m.model !== o.model)
                o.observer?.onNotice?.(`Claude Code reports model ${m.model} (requested ${o.model})`);
            return;
        }
        if (m.type === 'assistant') {
            if (m.parent_tool_use_id !== null || !t)
                return; // subagent traffic isn't routed; modelUsage deltas still count its spend
            const msg = m.message;
            const u = msg.usage;
            // Assistant messages are block-level: several can share message.id and their
            // usage is not final until the last block, so keep the latest seen per id.
            let info = t.calls.get(msg.id);
            const fresh = !info;
            if (!info) {
                const requested = this.effort ?? 'medium';
                info = {
                    requested,
                    applied: this.appliedEffort === requested,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 0,
                };
                t.calls.set(msg.id, info);
                t.lastCall = info;
            }
            info.inputTokens = u?.input_tokens ?? info.inputTokens;
            info.cacheReadTokens = u?.cache_read_input_tokens ?? info.cacheReadTokens;
            info.cacheWriteTokens = u?.cache_creation_input_tokens ?? info.cacheWriteTokens;
            info.outputTokens = u?.output_tokens ?? info.outputTokens;
            if (fresh)
                o.observer?.onApiCall?.(info);
            o.trace?.({ event: 'api_call', messageId: msg.id, ...info });
            for (const block of msg.content) {
                if (block.type === 'text' && block.text.trim()) {
                    t.assistantNote = block.text;
                    o.observer?.onAssistantText?.(block.text);
                }
                else if (block.type === 'tool_use') {
                    this.toolNames.set(block.id, block.name);
                    o.observer?.onToolUse?.(block.name, describeToolInput(block.name, block.input));
                }
            }
            return;
        }
        if (m.type === 'user') {
            if (m.parent_tool_use_id !== null || !t)
                return;
            const content = m.message.content;
            if (typeof content === 'string')
                return;
            for (const block of content) {
                if (block.type !== 'tool_result')
                    continue;
                const tool = this.toolNames.get(block.tool_use_id) ?? 'tool';
                const text = typeof block.content === 'string' ? block.content : stringifyResult(block.content ?? '');
                const failed = block.is_error === true || t.failures.has(block.tool_use_id);
                o.observer?.onToolResult?.(tool, failed, clip(text.replace(/\s+/g, ' ').trim(), 140));
            }
            return;
        }
        if (m.type === 'result') {
            if (!t)
                return;
            this.task = null;
            const result = m.subtype === 'success' ? m.result : (m.errors?.join('; ') || m.subtype);
            this.lastResult = `User asked: ${clip(t.prompt, 300)}\nAgent answered: ${clip(result, 500)}`;
            // total_cost_usd and modelUsage are cumulative across this streaming-input
            // session, and modelUsage spans the whole query pipeline (main loop,
            // subagents, sidechains, helpers) — so task numbers are deltas between results.
            let counterReset = false;
            const delta = (total, previous) => {
                if (total < previous) {
                    counterReset = true; // a new epoch (e.g. /clear) — take the new value as the delta
                    return total;
                }
                return total - previous;
            };
            const modelUsage = m.modelUsage && typeof m.modelUsage === 'object' ? m.modelUsage : null;
            let modelCost = 0;
            const tokenTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
            if (modelUsage) {
                for (const u of Object.values(modelUsage)) {
                    if (!u || typeof u !== 'object')
                        continue;
                    tokenTotals.input += u.inputTokens ?? 0;
                    tokenTotals.output += u.outputTokens ?? 0;
                    tokenTotals.cacheRead += u.cacheReadInputTokens ?? 0;
                    tokenTotals.cacheWrite += u.cacheCreationInputTokens ?? 0;
                    modelCost += u.costUSD ?? 0;
                }
            }
            const costTotal = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : modelCost;
            const costUsd = delta(costTotal, this.lastTotals.costUsd);
            this.lastTotals.costUsd = costTotal;
            const calls = [...t.calls.values()];
            let usage;
            let tokens;
            if (modelUsage) {
                usage = {
                    input: delta(tokenTotals.input, this.lastTotals.tokens.input),
                    cacheRead: delta(tokenTotals.cacheRead, this.lastTotals.tokens.cacheRead),
                    cacheWrite: delta(tokenTotals.cacheWrite, this.lastTotals.tokens.cacheWrite),
                    output: delta(tokenTotals.output, this.lastTotals.tokens.output),
                };
                this.lastTotals.tokens = tokenTotals;
                tokens = 'task-delta';
            }
            else {
                // no pipeline-wide counters: only the calls observed on the main thread
                usage = {
                    input: calls.reduce((n, c) => n + c.inputTokens, 0),
                    cacheRead: calls.reduce((n, c) => n + c.cacheReadTokens, 0),
                    cacheWrite: calls.reduce((n, c) => n + c.cacheWriteTokens, 0),
                    output: calls.reduce((n, c) => n + c.outputTokens, 0),
                };
                tokens = 'main-thread-calls';
            }
            const report = {
                result,
                isError: m.is_error,
                subtype: m.subtype,
                costUsd,
                turns: m.num_turns,
                durationMs: m.duration_ms,
                decisions: t.decisions,
                callEfforts: calls.map((c) => c.requested),
                observedEfforts: t.observedEfforts,
                calls,
                usage,
                scope: { costUsd: 'task-delta', tokens },
                sessionTotals: { costUsd: costTotal, usage: { ...this.lastTotals.tokens } },
                counterReset,
            };
            if (counterReset)
                o.observer?.onNotice?.('Claude Code session counters reset — task cost/tokens are the new epoch totals');
            o.trace?.({
                event: 'result', subtype: m.subtype, costUsd: report.costUsd, sessionCostUsd: costTotal,
                turns: report.turns, usage: report.usage, scope: report.scope, counterReset,
                callEfforts: report.callEfforts, calls: report.calls,
            });
            t.resolve(report);
        }
    }
    async onToolFailure(input) {
        if (input.hook_event_name !== 'PostToolUseFailure' || input.agent_id || !this.task)
            return;
        this.task.failures.set(input.tool_use_id, input.error);
    }
    /** Runs after every tool batch, before Claude Code's next API request. */
    async onToolBatch(input) {
        const t = this.task;
        if (input.hook_event_name !== 'PostToolBatch' || input.agent_id || !t || !this.q)
            return;
        const { router, observer } = this.opts;
        const observed = input.effort?.level;
        if (observed) {
            t.observedEfforts.push(observed);
            if (t.lastCall)
                t.lastCall.observed = observed;
            if (this.effort && observed !== this.effort) {
                observer?.onNotice?.(`Claude Code ran that turn at ${observed}, expected ${this.effort}`);
            }
        }
        const batch = input.tool_calls.map((c) => {
            const error = t.failures.get(c.tool_use_id);
            return {
                tool: c.tool_name,
                summary: describeToolInput(c.tool_name, c.tool_input),
                runner: testRunner(c.tool_name, c.tool_input),
                failed: error !== undefined || looksFailed(c.tool_name, c.tool_response),
                result: error ?? clip(stringifyResult(c.tool_response), 600),
            };
        });
        t.turn += 1;
        t.consecutiveFailures = batch.some((c) => c.failed) ? t.consecutiveFailures + 1 : 0;
        const current = this.effort ?? 'medium';
        const decision = await router.routeStep({
            prompt: t.prompt,
            profile: t.profile,
            turn: t.turn,
            current,
            consecutiveFailures: t.consecutiveFailures,
            assistantNote: t.assistantNote,
            lastBatch: batch,
            trajectory: t.trajectory,
        });
        t.trajectory.push(`step ${t.turn} @${current}: ${batch.map((c) => `${c.tool} ${clip(c.summary, 60)} ${c.failed ? 'FAILED' : 'ok'}`).join('; ')}`);
        this.effort = decision.effort;
        t.decisions.push(decision);
        observer?.onDecision?.(decision);
        this.opts.trace?.({ event: 'decision', turn: t.turn, ...decision });
        if (decision.effort !== this.appliedEffort) {
            await this.q.applyFlagSettings({ effortLevel: decision.effort });
            this.appliedEffort = decision.effort;
        }
    }
}
