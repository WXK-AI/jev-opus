import { config } from '../config.ts';

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

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export type JevAnswer =
  | { kind: 'noul'; p: number }
  | { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

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

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export function neutralAnswers(questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[name] = { kind: 'noul', p: 0.5 };
    else if (q.type === 'choice') out[name] = { kind: 'choice', choice: Object.keys(q.criteria)[0] ?? '', confidence: 0, probabilities: {} };
    else out[name] = { kind: 'score', score: (q.criteria.length - 1) / 2, confidence: 0, probabilities: {} };
  }
  return out;
}

export function parseAnswers(raw: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const all = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const neutral = neutralAnswers(questions);
  const out: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = all[name];
    if (!a) { out[name] = neutral[name]!; continue; }
    const probabilities = (typeof a.probabilities === 'object' && a.probabilities ? a.probabilities : {}) as Record<string, number>;
    if (q.type === 'noul') {
      out[name] = { kind: 'noul', p: clamp01(Number(a.noul ?? 0.5)) };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const choice = typeof a.choice === 'string' && keys.includes(a.choice) ? a.choice : keys[0] ?? '';
      out[name] = { kind: 'choice', choice, confidence: clamp01(Number(a.confidence ?? 0)), probabilities };
    } else {
      const top = q.criteria.length - 1;
      const score = Math.min(top, Math.max(0, Number(a.score ?? top / 2)));
      out[name] = { kind: 'score', score: Number.isFinite(score) ? score : top / 2, confidence: clamp01(Number(a.confidence ?? 0)), probabilities };
    }
  }
  return out;
}

export class JevClient implements JevLike {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  queries = 0;
  failures = 0;
  inputTokens = 0;
  totalLatencyMs = 0;

  private readonly provider: 'typesafe' | 'openrouter';

  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string; provider?: 'typesafe' | 'openrouter' } = {}) {
    this.provider = opts.provider ?? config.jev.provider;
    const or = this.provider === 'openrouter';
    this.apiKey = opts.apiKey ?? (or ? config.jev.openrouterKey : config.jev.apiKey);
    this.baseUrl = opts.baseUrl ?? (or ? config.jev.openrouterUrl : config.jev.baseUrl);
    this.model = opts.model ?? (or ? config.jev.openrouterModel : config.jev.model);
  }

  get providerName(): string {
    return this.provider;
  }

  private requestBody(state: string, questions: Record<string, JevQuestion>): string {
    const body: Record<string, unknown> = { state, model: this.model, questions };
    // OpenRouter: pin the TypeSafe provider so no other model ever answers.
    if (this.provider === 'openrouter') body.provider = { only: ['typesafe'], allow_fallbacks: false };
    return JSON.stringify(body);
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  get costUsd(): number {
    return (this.inputTokens / 1_000_000) * config.jev.inputPricePerMillion;
  }

  async ask(state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const start = Date.now();
    if (!this.enabled) {
      return { answers: neutralAnswers(questions), failed: true, error: this.provider === 'openrouter' ? 'OPENROUTER_API_KEY not set' : 'JEV_API_KEY not set', latencyMs: 0, inputTokens: 0 };
    }
    this.queries++;
    let lastError = 'request failed';
    for (let attempt = 0; attempt <= config.jev.retries; attempt++) {
      try {
        const res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: this.requestBody(state, questions),
          signal: AbortSignal.timeout(config.jev.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = `Jev HTTP ${res.status}`;
        } else if (!res.ok) {
          lastError = `Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
          break; // 4xx other than 429 won't improve on retry
        } else {
          const data = (await res.json()) as { answers?: unknown; usage?: { input_tokens?: number } };
          const latencyMs = Date.now() - start;
          const inputTokens = data.usage?.input_tokens ?? 0;
          this.inputTokens += inputTokens;
          this.totalLatencyMs += latencyMs;
          return { answers: parseAnswers(data.answers, questions), failed: false, latencyMs, inputTokens };
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (attempt < config.jev.retries) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    this.failures++;
    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    return { answers: neutralAnswers(questions), failed: true, error: lastError, latencyMs, inputTokens: 0 };
  }
}
