import { type Effort } from '../effort.ts';
import type { ToolCallSummary } from '../router/types.ts';
/**
 * Pure helpers for rewriting Claude Code's /v1/messages requests.
 *
 * Effort changes are inserted as effort-only system messages
 * (`{role: "system", content: [], output_config: {effort}}`, beta
 * `mid-conversation-output-config-2026-07-01`). Claude Code resends the whole
 * history on every request, so every insertion made so far is replayed at the
 * same position each time. The prefix the model saw stays identical, which
 * keeps both the prompt cache and preserved-thinking blocks valid.
 */
export declare const JEV_MODEL_PREFIX = "jev/";
export declare const PER_MESSAGE_EFFORT_BETAS: string[];
type Json = Record<string, unknown>;
export type Message = {
    role: string;
    content: unknown;
    output_config?: {
        effort?: unknown;
    };
} & Json;
export interface Insertion {
    /** insert before this index of Claude Code's own (unmodified) messages array */
    index: number;
    effort: Effort;
    /** rolling hash of original messages[0..index) — the prefix this insertion belongs to */
    prefixHash: string;
}
export declare function isJevModel(model: unknown): model is string;
export declare function stripJevModel(model: string): string;
/**
 * Canonical form for prefix comparison: Claude Code moves `cache_control`
 * breakpoints between requests and may resend string content as a text-block
 * array (or back). The API renders both identically, so neither counts as a change.
 */
export declare function canonical(value: unknown): unknown;
/** prefixHashes[i] = hash of canonical messages[0..i); length = messages.length + 1 */
export declare function prefixHashes(messages: readonly unknown[]): string[];
export declare function lastIndexOfRole(messages: readonly Message[], role: string): number;
/** Latest effort statement Claude Code itself put in the history (its /effort level). */
export declare function clientEffort(messages: readonly Message[]): {
    effort: Effort;
    index: number;
} | null;
export declare function effortMessage(effort: Effort): Message;
export declare function isEffortStatement(m: unknown): m is Message;
/** Replay insertions into Claude Code's messages (insertions sorted by index). */
export declare function applyInsertions(messages: readonly Message[], insertions: readonly Insertion[]): Message[];
/** Effort in force for the final message: last effort statement before it, else the top-level value. */
export declare function effortInForce(messages: readonly Message[], topLevel: unknown): Effort;
export declare function addBeta(header: string | undefined): string;
/** Human-authored text of a user message, without Claude Code's injected reminders. */
export declare function userText(m: Message | undefined): string;
export declare function hasToolResults(m: Message | undefined): boolean;
/** The last user message that carries a human prompt (for the task goal). */
export declare function lastPrompt(messages: readonly Message[]): string;
/** The tool round that just finished: the last assistant's tool calls paired with the last user message's results. */
export declare function lastToolRound(messages: readonly Message[]): {
    note: string;
    batch: ToolCallSummary[];
};
export {};
