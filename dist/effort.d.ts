import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
export type Effort = EffortLevel;
/** Ordered weakest → strongest. Index is the effort's rank. */
export declare const EFFORT_LEVELS: readonly Effort[];
export declare function isEffort(value: unknown): value is Effort;
export declare function rank(effort: Effort): number;
export declare function fromRank(r: number): Effort;
export declare function shift(effort: Effort, delta: number): Effort;
export declare function clampEffort(effort: Effort, min: Effort, max: Effort): Effort;
export declare function maxEffort(a: Effort, b: Effort): Effort;
export declare function minEffort(a: Effort, b: Effort): Effort;
