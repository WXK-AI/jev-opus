import { type Effort } from '../effort.ts';
import type { ToolCallSummary } from './types.ts';
/**
 * Pure reducer over tool batches.
 *
 * Tracks unresolved issues by a stable failure fingerprint (normalized error
 * text plus the command/test that produced it), the effort levels already
 * tried against each issue, batch-to-batch progress, and failures that are
 * environment blockers rather than reasoning problems. No I/O, no wall clock,
 * no randomness: the whole state is JSON-serializable so an adapter can
 * snapshot it and restore the common-ancestor state after a rewind.
 */
export interface Issue {
    /** stable identity: hash of normalized error text + command/test (never raw text, it is persisted) */
    fingerprint: string;
    /** hash of the command/test identity; a later pass with the same key clears the issue */
    command: string;
    /** readable command, in memory only for the Jev prompt; never serialized */
    label?: string;
    /** failure is an environment blocker (network, permissions, missing infra…) */
    environment: boolean;
    /** batches in which this fingerprint has been observed failing */
    attempts: number;
    /** effort levels in force when this issue was observed failing */
    tried: Effort[];
    /** batch index when this issue was last observed */
    lastSeen: number;
}
export interface BatchOutcome {
    /** issues first observed failing in this batch */
    newIssues: Issue[];
    /** previously-open issues that failed again in this batch */
    repeated: Issue[];
    /** issues cleared because their command/test passed in this batch */
    resolved: Issue[];
    /** tool calls that failed in this batch, environment or not */
    failedCalls: number;
    /** failed calls classified as environment blockers */
    environmentFailures: number;
    /** every failure in this batch was an environment blocker */
    environmentOnly: boolean;
    /** how the latest batch changed outcomes */
    progress: 'new-failure' | 'repeat-failure' | 'resolved' | 'steady';
}
export interface CoreState {
    /** batches reduced so far */
    clock: number;
    issues: Issue[];
    /** outcome of the most recent batch (transient; not serialized) */
    last: BatchOutcome | null;
}
export declare function emptyCore(): CoreState;
/** Command/test identity: which later pass can clear the issue. */
export declare function commandKey(call: ToolCallSummary): string;
/** Strip volatile content (numbers, paths, timestamps, ANSI) so the same error fingerprints identically. */
export declare function normalizeError(text: string): string;
/**
 * Identities are hashed: router snapshots are journaled to disk, and commands
 * or tool output can contain file contents or secrets.
 */
export declare function identity(text: string): string;
/** Stable failure fingerprint: the command/test plus its normalized error text. */
export declare function fingerprint(call: ToolCallSummary): string;
export declare function isEnvironmentFailure(call: ToolCallSummary): boolean;
/** Issues that reflect reasoning problems, not environment blockers. */
export declare function reasoningIssues(state: CoreState): Issue[];
/**
 * Fold one tool batch into the state. A successful call only clears issues
 * whose command/test key matches; unrelated successes leave issues open.
 */
export declare function reduceBatch(state: CoreState, batch: readonly ToolCallSummary[], effort: Effort): {
    state: CoreState;
    outcome: BatchOutcome;
};
/** The serializable part of the reducer state. */
export declare function serializeCore(s: CoreState): {
    clock: number;
    issues: Issue[];
};
/** Tolerant restore: invalid issues are dropped, a missing/garbage payload yields null. */
export declare function reviveCore(raw: unknown): CoreState | null;
