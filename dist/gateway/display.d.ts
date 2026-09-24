import type { Settings, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { EffortDecision } from '../router/types.ts';
export declare function formatEffortBadge(d: EffortDecision, showChange?: boolean): string;
/** "LOW → MEDIUM → HIGH": every level since the last badge, oldest first. */
export declare function formatEffortTrail(trail: readonly string[], d: EffortDecision): string;
/**
 * UI state only. No hook output is added to Claude's model conversation.
 *
 * Effort usually changes during tool-only steps, where Claude writes no text.
 * Rather than a notice per change, the next text badge shows the whole path
 * since the previous badge (for example LOW → MEDIUM → HIGH), and the status
 * line shows the live level. Per-tool notices are opt-in.
 */
export declare class EffortDisplay {
    private readonly entries;
    private readonly maxEntries;
    constructor(maxEntries?: number);
    record(session: string, agent: string, decision: EffortDecision): void;
    clear(session: string, agent: string): void;
    handle(input: unknown): SyncHookJSONOutput;
}
/** Local HTTP hooks avoid spawning a Node process for every streamed text delta. */
export declare function inlineEffortSettings(hookUrl: string, opts?: {
    toolNotices?: boolean;
}): Pick<Settings, 'hooks'>;
