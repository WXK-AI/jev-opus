import type { StepContext, TaskProfile, StepSignals } from './types.ts';
export declare function heuristicTaskProfile(prompt: string): TaskProfile;
export declare function heuristicStepSignals(ctx: StepContext, opts?: {
    ignoreFailures?: boolean;
}): StepSignals;
