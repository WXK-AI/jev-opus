import { type CanUseTool, type Options, type PermissionMode, type Query, type SDKUserMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { Effort } from '../effort.ts';
import type { EffortRouter } from '../router/router.ts';
import type { EffortDecision } from '../router/types.ts';
export type QueryFn = (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
}) => Query;
export interface ApiCallInfo {
    effort: Effort;
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
export interface TaskReport {
    result: string;
    isError: boolean;
    subtype: string;
    costUsd: number;
    turns: number;
    durationMs: number;
    decisions: EffortDecision[];
    /** effort level used for each API call of this prompt, in order */
    callEfforts: Effort[];
    /** effort levels Claude Code itself reported to our hooks */
    observedEfforts: string[];
    usage: {
        input: number;
        cacheRead: number;
        cacheWrite: number;
        output: number;
    };
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
    private effort;
    private task;
    private seenMessageIds;
    private toolNames;
    private lastResult;
    private ended;
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
