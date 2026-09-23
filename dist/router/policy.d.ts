import { type Effort } from '../effort.ts';
import type { StepSignals, TaskProfile } from './types.ts';
/**
 * Pure mapping from Jev signals to an Opus 5.5 effort level.
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
export declare function difficultyRank(d: number): number;
export declare function taskEffort(p: TaskProfile, bounds: Bounds): {
    effort: Effort;
    reasons: string[];
};
export declare function stepTarget(base: Effort, s: StepSignals, consecutiveFailures: number, bounds: Bounds): {
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
