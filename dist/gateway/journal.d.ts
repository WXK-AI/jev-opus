import type { Effort } from '../effort.ts';
import type { RouterSnapshot } from '../router/router.ts';
import type { EffortDecision, TaskProfile } from '../router/types.ts';
import type { Insertion } from './transcript.ts';
/**
 * Durable, append-only decision journal.
 *
 * One JSONL file per conversation key. The file name is a SHA-256 of the
 * `session|agent|first-message-hash` key, so session identifiers and transcript
 * content never appear on disk. Records carry hashes, effort levels, counters,
 * and opaque router snapshots — never prompt text, tool output, or credentials.
 *
 * A decision is appended with status `prepared` BEFORE the request is forwarded
 * upstream. Later states (`sent` / `completed` / `failed` / `unknown`) and
 * final usage are appended as small update lines carrying the same
 * `decisionId`; `records()` folds them onto their record, so the journal stays
 * append-only while still exposing each decision's latest state.
 *
 * On an in-memory thread-cache miss (eviction or restart) the gateway rebuilds
 * the thread from these records and replays exactly the statements sent before.
 */
export type JournalStatus = 'prepared' | 'sent' | 'completed' | 'failed' | 'unknown';
export interface JournalUsage {
    model?: string;
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
}
export interface JournalRecord {
    decisionId: string;
    /** Complete sanitized routing explanation; absent in legacy journals. */
    decision?: EffortDecision;
    bounds?: {
        min: Effort;
        max: Effort;
    };
    attempts?: JournalAttempt[];
    legacyUsage?: JournalUsage;
    updatedAt?: number;
    /** hash of canonical messages[0..lastUser] + model + top-level output_config */
    requestFingerprint: string;
    /** index of the user message this boundary governs */
    lastUser: number;
    /** rolling prefix hash of canonical messages[0..lastUser] — finds common ancestors */
    boundaryHash: string;
    /** every insertion applied to the forwarded request, in order */
    insertions: Insertion[];
    /** opaque controller state after this decision; restores the common ancestor */
    routerSnapshot: RouterSnapshot;
    /** policy / question-set versions, for provenance */
    policy: string;
    /** the effort this decision put in force */
    requested: Effort;
    /** effort that was in force immediately before this decision */
    current: Effort;
    kind: 'task' | 'step';
    manual: boolean;
    turn: number;
    consecutiveFailures: number;
    /** latest effort statement Claude Code itself had sent at decision time */
    clientEffort: Effort | null;
    profile: TaskProfile | null;
    status: JournalStatus;
    at: number;
    usage?: JournalUsage;
    error?: string;
}
export interface JournalAttempt {
    attemptId: string;
    status: JournalStatus;
    sentAt: number;
    completedAt?: number;
    usage?: JournalUsage;
    error?: string;
    responseId?: string;
    providerRequestId?: string;
    usageComplete?: boolean;
}
export interface JournalAnnotation {
    event: 'annotation_returned';
    decisionId: string;
    attemptId?: string;
    at: number;
    badge: string;
    hook: string;
    messageId?: string;
    turnId?: string;
    toolUseId?: string;
    association: 'tool-id' | 'session-latest';
}
/** Status/usage transition appended under an existing decisionId. */
export interface JournalUpdate {
    attemptId?: string;
    responseId?: string;
    providerRequestId?: string;
    usageComplete?: boolean;
    decisionId: string;
    status: JournalStatus;
    at: number;
    usage?: JournalUsage;
    error?: string;
}
export type JournalLine = JournalRecord | JournalUpdate | JournalAnnotation;
export declare function isJournalRecord(line: JournalLine): line is JournalRecord;
export declare class Journal {
    readonly dir: string;
    constructor(dir: string);
    /** One file per conversation; the name is a hash, never the raw key. */
    private file;
    append(key: string, line: JournalLine): void;
    /**
     * All decisions for a conversation, in append order, with later status/usage
     * lines folded onto their record. Corrupt records fail recovery explicitly.
     */
    records(key: string): JournalRecord[];
    events(key: string): JournalLine[];
}
export declare function readJournalFile(file: string): JournalLine[];
/** Recovery projection with per-attempt accounting. Raw annotations remain available via events(). */
export declare function foldJournal(lines: JournalLine[]): JournalRecord[];
