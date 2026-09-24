/**
 * TypeSafe Jev System-1 client.
 *
 * Wire format:
 *   POST { state, model, questions: { name: { type, instructions, criteria? } } }
 *   →   { model, answers: { name: {...} }, usage: { input_tokens, output_tokens } }
 *
 * Never throws: any transport/validation failure yields `failed: true` with
 * per-question `signals`, so callers can fall back to heuristics. One overall
 * deadline bounds the whole call; a circuit breaker skips the fetch entirely
 * while Jev is failing repeatedly.
 */
export type JevQuestion = {
    type: 'noul';
    instructions: string;
} | {
    type: 'choice';
    instructions: string;
    criteria: Record<string, string>;
} | {
    type: 'score';
    instructions: string;
    criteria: readonly string[];
};
export type JevAnswer = {
    kind: 'noul';
    p: number;
} | {
    kind: 'choice';
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
} | {
    kind: 'score';
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
};
/** Per-question outcome of validating one Jev response. */
export type JevSignal = 'valid' | 'missing' | 'invalid';
export interface JevResult {
    answers: Record<string, JevAnswer>;
    /** Validity per question. Optional only so older scripted JevLike stubs still satisfy the interface. */
    signals?: Record<string, JevSignal>;
    failed: boolean;
    error?: string;
    /** Set when the circuit breaker returned without calling Jev. */
    circuitOpen?: boolean;
    latencyMs: number;
    inputTokens: number;
}
export interface JevLike {
    readonly enabled: boolean;
    ask(state: string, questions: Record<string, JevQuestion>, opts?: {
        signal?: AbortSignal;
    }): Promise<JevResult>;
}
export declare function neutralAnswers(questions: Record<string, JevQuestion>): Record<string, JevAnswer>;
export declare function parseAnswers(raw: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer>;
/**
 * Validate a raw Jev `answers` object against the question set. A question with
 * no entry is 'missing'; an entry that violates the schema is 'invalid'. Only
 * 'valid' questions appear in `answers` — no neutral stand-ins, no clamping,
 * no manufactured first-category choices.
 */
export declare function validateAnswers(raw: unknown, questions: Record<string, JevQuestion>): {
    answers: Record<string, JevAnswer>;
    signals: Record<string, JevSignal>;
};
export interface JevClientOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    provider?: 'typesafe' | 'openrouter';
    /** Overall deadline for one ask(), covering all retries. Default config.jev.deadlineMs. */
    deadlineMs?: number;
    /** Extra attempts within the same deadline. Default config.jev.retries (0). */
    retries?: number;
    /** Consecutive failures before the circuit opens. Default config.jev.breakerThreshold. */
    breakerThreshold?: number;
    /** How long the circuit stays open before one probe is allowed. Default config.jev.breakerCooldownMs. */
    breakerCooldownMs?: number;
    /** Injectable clock for breaker timing and latency, for tests. */
    now?: () => number;
}
export declare class JevClient implements JevLike {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly model;
    private readonly deadlineMs;
    private readonly maxRetries;
    private readonly breakerThreshold;
    private readonly breakerCooldownMs;
    private readonly now;
    private consecutiveFailures;
    private breakerOpenUntil;
    private probing;
    queries: number;
    failures: number;
    inputTokens: number;
    totalLatencyMs: number;
    private readonly provider;
    constructor(opts?: JevClientOptions);
    get providerName(): string;
    private requestBody;
    get enabled(): boolean;
    get costUsd(): number;
    private noteSuccess;
    private noteFailure;
    ask(state: string, questions: Record<string, JevQuestion>, opts?: {
        signal?: AbortSignal;
    }): Promise<JevResult>;
}
