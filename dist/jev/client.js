import { config } from '../config.js';
const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const num01 = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function neutralAnswers(questions) {
    const out = {};
    for (const [name, q] of Object.entries(questions)) {
        if (q.type === 'noul')
            out[name] = { kind: 'noul', p: 0.5 };
        else if (q.type === 'choice')
            out[name] = { kind: 'choice', choice: Object.keys(q.criteria)[0] ?? '', confidence: 0, probabilities: {} };
        else
            out[name] = { kind: 'score', score: (q.criteria.length - 1) / 2, confidence: 0, probabilities: {} };
    }
    return out;
}
export function parseAnswers(raw, questions) {
    const all = (raw ?? {});
    const neutral = neutralAnswers(questions);
    const out = {};
    for (const [name, q] of Object.entries(questions)) {
        const a = all[name];
        if (!a) {
            out[name] = neutral[name];
            continue;
        }
        const probabilities = (typeof a.probabilities === 'object' && a.probabilities ? a.probabilities : {});
        if (q.type === 'noul') {
            out[name] = { kind: 'noul', p: clamp01(Number(a.noul ?? 0.5)) };
        }
        else if (q.type === 'choice') {
            const keys = Object.keys(q.criteria);
            const choice = typeof a.choice === 'string' && keys.includes(a.choice) ? a.choice : keys[0] ?? '';
            out[name] = { kind: 'choice', choice, confidence: clamp01(Number(a.confidence ?? 0)), probabilities };
        }
        else {
            const top = q.criteria.length - 1;
            const score = Math.min(top, Math.max(0, Number(a.score ?? top / 2)));
            out[name] = { kind: 'score', score: Number.isFinite(score) ? score : top / 2, confidence: clamp01(Number(a.confidence ?? 0)), probabilities };
        }
    }
    return out;
}
function validateAnswer(a, q) {
    // Optional fields must still be well-formed when present — a malformed
    // response is rejected, never silently clamped into high confidence.
    if (a.confidence !== undefined && !num01(a.confidence))
        return null;
    const probabilities = {};
    if (a.probabilities !== undefined) {
        if (a.probabilities === null || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities))
            return null;
        for (const [k, v] of Object.entries(a.probabilities)) {
            if (typeof v !== 'number' || !Number.isFinite(v))
                return null;
            probabilities[k] = v;
        }
    }
    const confidence = num01(a.confidence) ? a.confidence : 0;
    if (q.type === 'noul') {
        return num01(a.noul) ? { kind: 'noul', p: a.noul } : null;
    }
    if (q.type === 'choice') {
        if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice))
            return null;
        return { kind: 'choice', choice: a.choice, confidence, probabilities };
    }
    const top = q.criteria.length - 1;
    return typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= top
        ? { kind: 'score', score: a.score, confidence, probabilities }
        : null;
}
/**
 * Validate a raw Jev `answers` object against the question set. A question with
 * no entry is 'missing'; an entry that violates the schema is 'invalid'. Only
 * 'valid' questions appear in `answers` — no neutral stand-ins, no clamping,
 * no manufactured first-category choices.
 */
export function validateAnswers(raw, questions) {
    const all = (raw !== null && typeof raw === 'object' ? raw : {});
    const answers = {};
    const signals = {};
    for (const [name, q] of Object.entries(questions)) {
        const a = all[name];
        if (a === undefined || a === null) {
            signals[name] = 'missing';
            continue;
        }
        const parsed = typeof a === 'object' && !Array.isArray(a) ? validateAnswer(a, q) : null;
        if (parsed) {
            answers[name] = parsed;
            signals[name] = 'valid';
        }
        else {
            signals[name] = 'invalid';
        }
    }
    return { answers, signals };
}
function missingSignals(questions) {
    return Object.fromEntries(Object.keys(questions).map((k) => [k, 'missing']));
}
export class JevClient {
    apiKey;
    baseUrl;
    model;
    deadlineMs;
    maxRetries;
    breakerThreshold;
    breakerCooldownMs;
    now;
    consecutiveFailures = 0;
    breakerOpenUntil = 0;
    probing = false;
    queries = 0;
    failures = 0;
    inputTokens = 0;
    totalLatencyMs = 0;
    provider;
    constructor(opts = {}) {
        this.provider = opts.provider ?? config.jev.provider;
        const or = this.provider === 'openrouter';
        this.apiKey = opts.apiKey ?? (or ? config.jev.openrouterKey : config.jev.apiKey);
        this.baseUrl = opts.baseUrl ?? (or ? config.jev.openrouterUrl : config.jev.baseUrl);
        this.model = opts.model ?? (or ? config.jev.openrouterModel : config.jev.model);
        this.deadlineMs = opts.deadlineMs ?? config.jev.deadlineMs;
        this.maxRetries = opts.retries ?? config.jev.retries;
        this.breakerThreshold = Math.max(1, opts.breakerThreshold ?? config.jev.breakerThreshold);
        this.breakerCooldownMs = opts.breakerCooldownMs ?? config.jev.breakerCooldownMs;
        this.now = opts.now ?? Date.now;
    }
    get providerName() {
        return this.provider;
    }
    requestBody(state, questions) {
        const body = { state, model: this.model, questions };
        // OpenRouter: pin the TypeSafe provider so no other model ever answers.
        if (this.provider === 'openrouter')
            body.provider = { only: ['typesafe'], allow_fallbacks: false };
        return JSON.stringify(body);
    }
    get enabled() {
        return this.apiKey.length > 0;
    }
    get costUsd() {
        return (this.inputTokens / 1_000_000) * config.jev.inputPricePerMillion;
    }
    noteSuccess() {
        this.consecutiveFailures = 0;
        this.breakerOpenUntil = 0;
        this.probing = false;
    }
    noteFailure() {
        this.consecutiveFailures++;
        // A failed probe re-opens immediately; otherwise open at the threshold.
        if (this.probing || this.consecutiveFailures >= this.breakerThreshold) {
            this.breakerOpenUntil = this.now() + this.breakerCooldownMs;
        }
        this.probing = false;
    }
    async ask(state, questions, opts = {}) {
        const start = this.now();
        if (!this.enabled) {
            return {
                answers: {},
                signals: missingSignals(questions),
                failed: true,
                error: this.provider === 'openrouter' ? 'OPENROUTER_API_KEY not set' : 'JEV_API_KEY not set',
                latencyMs: 0,
                inputTokens: 0,
            };
        }
        // Circuit breaker: while open, fail without fetching. After the cooldown,
        // the first real call becomes the single recovery probe.
        if (this.breakerOpenUntil > 0 && (this.now() < this.breakerOpenUntil || this.probing)) {
            return {
                answers: {},
                signals: missingSignals(questions),
                failed: true,
                error: 'circuit open',
                circuitOpen: true,
                latencyMs: 0,
                inputTokens: 0,
            };
        }
        if (this.breakerOpenUntil > 0)
            this.probing = true;
        this.queries++;
        // One overall deadline bounds every attempt; the caller's signal composes with it.
        const deadline = AbortSignal.timeout(this.deadlineMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
        let lastError = 'request failed';
        let signals = missingSignals(questions);
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (signal.aborted) {
                lastError = opts.signal?.aborted ? 'aborted by caller' : 'deadline exceeded';
                break;
            }
            try {
                const res = await fetch(this.baseUrl, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                    body: this.requestBody(state, questions),
                    signal,
                });
                if (res.status === 429 || res.status >= 500) {
                    lastError = `Jev HTTP ${res.status}`;
                }
                else if (!res.ok) {
                    lastError = `Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
                    break; // 4xx other than 429 won't improve on retry
                }
                else {
                    const data = (await res.json());
                    const parsed = validateAnswers(data.answers, questions);
                    signals = parsed.signals;
                    const inputTokens = data.usage?.input_tokens ?? 0;
                    this.inputTokens += inputTokens;
                    const latencyMs = Math.max(0, this.now() - start);
                    if (Object.values(signals).includes('valid')) {
                        this.noteSuccess();
                        this.totalLatencyMs += latencyMs;
                        return { answers: parsed.answers, signals, failed: false, latencyMs, inputTokens };
                    }
                    lastError = 'no valid answers in response';
                }
            }
            catch (err) {
                lastError = signal.aborted
                    ? opts.signal?.aborted
                        ? 'aborted by caller'
                        : 'deadline exceeded'
                    : err.message;
            }
            if (attempt < this.maxRetries) {
                const remaining = this.deadlineMs - (this.now() - start);
                if (remaining <= 0)
                    break;
                await new Promise((r) => setTimeout(r, Math.min(300 * 2 ** attempt, remaining)));
            }
        }
        this.noteFailure();
        this.failures++;
        const latencyMs = Math.max(0, this.now() - start);
        this.totalLatencyMs += latencyMs;
        return { answers: {}, signals, failed: true, error: lastError, latencyMs, inputTokens: 0 };
    }
}
