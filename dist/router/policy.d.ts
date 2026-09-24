import { type Effort } from '../effort.ts';
import type { StepSignals, TaskProfile } from './types.ts';
/**
 * Pure mapping from evidence and Jev signals to an Opus 5.5 effort level.
 *
 * Calibrated for Opus 5.5, whose `medium` already beats Opus 5 at `high` on
 * coding work: `medium` is the workhorse, `high`/`xhigh` are for hard or
 * failing steps, and `max` is reserved for extreme high-stakes work or an
 * agent that stays stuck after escalation.
 */
export interface Bounds {
    min: Effort;
    max: Effort;
}
/** Version of this policy, recorded on every decision for provenance. */
export declare const POLICY_VERSION = "policy.v2";
/** Misordered bounds are a configuration error: swap them rather than crash. */
export declare function normalizeBounds(b: Bounds): Bounds;
export declare function difficultyRank(d: number): number;
export declare function taskEffort(p: TaskProfile, bounds: Bounds): {
    effort: Effort;
    reasons: string[];
};
/** What the reducer observed, distilled for the policy. */
export interface StepEvidence {
    /** unresolved issues that are not environment blockers */
    unresolved: number;
    /** a non-environment issue failed again this batch (stalled recovery) */
    repeated: boolean;
    /** effort levels already tried on the non-environment issues that failed this batch */
    triedOnFailure: readonly Effort[];
    /** attempts so far on the most-retried unresolved issue */
    maxAttempts: number;
    /** every failure this batch was an environment blocker */
    environmentOnly: boolean;
    /** positive evidence that the next step is routine */
    routineOk: boolean;
}
export declare function stepTarget(base: Effort, s: StepSignals, ev: StepEvidence, current: Effort): {
    effort: Effort;
    reasons: string[];
};
/**
 * Anti-flapping: raises apply at once; after a raise the level is held for
 * one more step; decreases step down one level at a time (except when the
 * work is finishing, which drops straight to the target).
 */
export declare function applyHysteresis(current: Effort, target: Effort, hold: number, finishing: boolean): {
    effort: Effort;
    hold: number;
    note?: string;
};
