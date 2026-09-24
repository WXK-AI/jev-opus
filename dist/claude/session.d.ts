import { type CanUseTool, type Options, type PermissionMode, type Query, type SDKUserMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { Effort } from '../effort.ts';
import type { EffortRouter } from '../router/router.ts';
import type { EffortDecision } from '../router/types.ts';
export type QueryFn = (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
}) => Query;
export interface ApiCallInfo {
    /** effort the router decided should govern this call */
    requested: Effort;
    /** the requested level was confirmed applied (start option, or applyFlagSettings resolved) */
    applied: boolean;
    /** effort Claude Code reported for the turn through our hooks, when available */
    observed?: string;
    /** latest usage seen for this message id — streamed blocks carry non-final usage */
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
}
export interface SessionObserver {
    onInit?(info: {
        model: string;
        claudeVersion?: string;
    }): void;
    onDecision?(d: EffortDecision): void;
    onAssistantText?(text: string): void;
    onToolUse?(tool: string, summary: string): void;
    onToolResult?(tool: string, failed: boolean, preview: string): void;
    onApiCall?(info: ApiCallInfo): void;
    onNotice?(message: string): void;
}
export interface UsageTotals {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}
/**
 * One prompt's outcome. `costUsd` and `usage` are this task's share: deltas of
 * the session's cumulative result counters (`total_cost_usd`, `modelUsage`
 * summed across models — which includes subagent and helper calls), while
 * `calls`/`callEfforts` cover only main-thread API calls we observed.
 * `scope` labels that coverage and `sessionTotals` carries the raw counters.
 */
export interface TaskReport {
    result: string;
    isError: boolean;
    subtype: string;
    /** this task's spend: delta of the session's cumulative total_cost_usd */
    costUsd: number;
    turns: number;
    durationMs: number;
    decisions: EffortDecision[];
    /** requested effort for each main-thread API call of this prompt, in order */
    callEfforts: Effort[];
    /** effort levels Claude Code itself reported to our hooks */
    observedEfforts: string[];
    /** per-call records for this prompt's main-thread API calls (subagent traffic excluded) */
    calls: ApiCallInfo[];
    /** this task's token usage — coverage is labelled by scope.tokens */
    usage: UsageTotals;
    scope: {
        costUsd: 'task-delta';
        tokens: 'task-delta' | 'main-thread-calls';
    };
    /** cumulative session counters carried by this result */
    sessionTotals: {
        costUsd: number;
        usage: UsageTotals;
    };
    /** a cumulative counter moved backwards (new epoch — deltas are the new totals) */
    counterReset: boolean;
}
export interface SessionOptions {
    router: EffortRouter;
    cwd: string;
    model: string;
    env: Record<string, string>;
    permissionMode: PermissionMode;
    canUseTool?: CanUseTool;
    settingSources: SettingSource[];
    claudePath?: string;
    maxTurns?: number;
    observer?: SessionObserver;
    queryFn?: QueryFn;
    /** receives every trace event (decisions, api calls, results) */
    trace?: (event: Record<string, unknown>) => void;
}
export declare class JevOpusSession {
    private readonly opts;
    private readonly input;
    private q;
    private pump;
    /** latest effort the router decided (requested) */
    private effort;
    /** latest effort confirmed pushed to Claude Code (start option or resolved applyFlagSettings) */
    private appliedEffort;
    private task;
    private toolNames;
    private lastResult;
    private ended;
    /** cumulative session counters carried by the last result — task numbers are deltas of these */
    private lastTotals;
    constructor(opts: SessionOptions);
    get currentEffort(): Effort | null;
    /** Route the prompt with Jev, set effort, run it to completion. */
    send(prompt: string): Promise<TaskReport>;
    /** Pin/unpin effort mid-session (REPL /pin, /auto). Applies immediately. */
    setPinned(effort: Effort | null): Promise<void>;
    close(): Promise<void>;
    private start;
    private consume;
    private handle;
    private onToolFailure;
    /** Runs after every tool batch, before Claude Code's next API request. */
    private onToolBatch;
}
