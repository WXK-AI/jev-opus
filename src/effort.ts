import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export type Effort = EffortLevel;

/** Ordered weakest → strongest. Index is the effort's rank. */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function rank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

export function fromRank(r: number): Effort {
  const i = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(r)));
  return EFFORT_LEVELS[i]!;
}

export function shift(effort: Effort, delta: number): Effort {
  return fromRank(rank(effort) + delta);
}

export function clampEffort(effort: Effort, min: Effort, max: Effort): Effort {
  return fromRank(Math.min(rank(max), Math.max(rank(min), rank(effort))));
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return rank(a) >= rank(b) ? a : b;
}

export function minEffort(a: Effort, b: Effort): Effort {
  return rank(a) <= rank(b) ? a : b;
}
