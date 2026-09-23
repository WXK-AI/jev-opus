/**
 * TypeSafe Jev System-1 client.
 *
 * Wire format:
 *   POST { state, model, questions: { name: { type, instructions, criteria? } } }
 *   →   { model, answers: { name: {...} }, usage: { input_tokens, output_tokens } }
 *
 * Never throws: any transport/parse failure yields neutral answers with
 * `failed: true`, so callers can fall back to heuristics.
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
export interface JevResult {
    answers: Record<string, JevAnswer>;
    failed: boolean;
    error?: string;
    latencyMs: number;
    inputTokens: number;
}
export interface JevLike {
    readonly enabled: boolean;
    ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResult>;
}
export declare function neutralAnswers(questions: Record<string, JevQuestion>): Record<string, JevAnswer>;
export declare function parseAnswers(raw: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer>;
export declare class JevClient implements JevLike {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly model;
    queries: number;
    failures: number;
    inputTokens: number;
    totalLatencyMs: number;
    private readonly provider;
    constructor(opts?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        provider?: 'typesafe' | 'openrouter';
    });
    get providerName(): string;
    private requestBody;
    get enabled(): boolean;
    get costUsd(): number;
    ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResult>;
}
