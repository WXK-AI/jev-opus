import type { Settings, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { EffortDecision } from '../router/types.ts';
export declare function formatEffortBadge(d: EffortDecision, showChange?: boolean): string;
/** UI state only. No hook output is added to Claude's model conversation. */
export declare class EffortDisplay {
    private readonly decisions;
    private readonly maxEntries;
    constructor(maxEntries?: number);
    record(session: string, agent: string, decision: EffortDecision): void;
    clear(session: string, agent: string): void;
    handle(input: unknown): SyncHookJSONOutput;
}
/** Local HTTP hooks avoid spawning a Node process for every streamed text delta. */
export declare function inlineEffortSettings(hookUrl: string): Pick<Settings, 'hooks'>;
