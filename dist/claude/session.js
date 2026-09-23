import { query as sdkQuery, } from '@anthropic-ai/claude-agent-sdk';
import { describeToolInput, looksFailed, stringifyResult } from './describe.js';
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
    effort = null;
    task = null;
    seenMessageIds = new Set();
    toolNames = new Map();
    lastResult = '';
    ended = null;
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
        if (!this.q)
            this.start(decision.effort);
        else if (decision.effort !== this.effort)
            await this.q.applyFlagSettings({ effortLevel: decision.effort });
        this.effort = decision.effort;
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
                callEfforts: [],
                observedEfforts: [],
                usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
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
        if (effort && this.q && effort !== this.effort) {
            await this.q.applyFlagSettings({ effortLevel: effort });
            this.effort = effort;
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
                return; // subagent traffic isn't routed
            const msg = m.message;
            if (!this.seenMessageIds.has(msg.id)) {
                this.seenMessageIds.add(msg.id);
                const effort = this.effort ?? 'medium';
                const u = msg.usage;
                const info = {
                    effort,
                    inputTokens: u.input_tokens ?? 0,
                    cacheReadTokens: u.cache_read_input_tokens ?? 0,
                    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
                    outputTokens: u.output_tokens ?? 0,
                };
                t.callEfforts.push(effort);
                t.usage.input += info.inputTokens;
                t.usage.cacheRead += info.cacheReadTokens;
                t.usage.cacheWrite += info.cacheWriteTokens;
                t.usage.output += info.outputTokens;
                o.observer?.onApiCall?.(info);
                o.trace?.({ event: 'api_call', ...info });
            }
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
            const report = {
                result,
                isError: m.is_error,
                subtype: m.subtype,
                costUsd: m.total_cost_usd,
                turns: m.num_turns,
                durationMs: m.duration_ms,
                decisions: t.decisions,
                callEfforts: t.callEfforts,
                observedEfforts: t.observedEfforts,
                usage: t.usage,
            };
            o.trace?.({ event: 'result', subtype: m.subtype, costUsd: report.costUsd, turns: report.turns, usage: report.usage, callEfforts: report.callEfforts });
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
            if (this.effort && observed !== this.effort) {
                observer?.onNotice?.(`Claude Code ran that turn at ${observed}, expected ${this.effort}`);
            }
        }
        const batch = input.tool_calls.map((c) => {
            const error = t.failures.get(c.tool_use_id);
            return {
                tool: c.tool_name,
                summary: describeToolInput(c.tool_name, c.tool_input),
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
        if (decision.changed) {
            await this.q.applyFlagSettings({ effortLevel: decision.effort });
            this.effort = decision.effort;
        }
        t.decisions.push(decision);
        observer?.onDecision?.(decision);
        this.opts.trace?.({ event: 'decision', turn: t.turn, ...decision });
    }
}
