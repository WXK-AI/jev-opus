import type { Settings, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { EffortDecision } from '../router/types.ts';
import type { JournalAnnotation } from './journal.ts';
export type DisplayMode = 'every-response' | 'changes' | 'off';
export declare function displayMode(value?: string | undefined): DisplayMode;
export declare function formatEffortBadge(d: EffortDecision, showChange?: boolean): string;
/** Retrospective path, never presented as the effort for one response. */
export declare function formatEffortTrail(trail: readonly string[], d: EffortDecision): string;
export interface DisplayContext {
    key: string;
    decisionId: string;
    attemptId?: string;
}
/** Visual-only annotations. Text-hook association is explicitly inferred, tool IDs are exact. */
export declare class EffortDisplay {
    private readonly entries;
    private readonly attempts;
    private readonly tools;
    private readonly messages;
    private readonly maxEntries;
    private readonly mode;
    private readonly showDecisionIds;
    private readonly onAnnotation?;
    constructor(maxEntries?: number, mode?: DisplayMode, onAnnotation?: (key: string, event: JournalAnnotation) => void, showDecisionIds?: boolean);
    record(session: string, agent: string, decision: EffortDecision, context?: DisplayContext): void;
    bindTool(session: string, agent: string, id: string, decision: EffortDecision, context: DisplayContext): void;
    markText(session: string, agent: string, context: DisplayContext): void;
    clear(session: string, agent: string): void;
    private set;
    handle(input: unknown): SyncHookJSONOutput;
}
/** Hook metadata stays out of the conversation and never changes tool permissions. */
export declare function inlineEffortSettings(hookUrl: string, opts?: {
    toolNotices?: boolean;
}): Pick<Settings, 'hooks'>;
