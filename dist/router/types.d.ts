import type { Effort } from '../effort.ts';
import type { JevResult } from '../jev/client.ts';
import type { Phase, TaskType } from './questions.ts';
/**
 * Jev result plus the fields the validating client adds. On older clients
 * `signals` is absent and every answer is present (treat those as valid);
 * the validating client omits missing/invalid answers instead.
 */
export type JevResponse = JevResult & {
    /** per-question evidence quality; undefined means an older client */
    signals?: Record<string, 'valid' | 'missing' | 'invalid'>;
    /** circuit breaker open → Jev unavailable for this call */
    circuitOpen?: boolean;
};
export interface TaskProfile {
    taskType: TaskType;
    typeConfidence: number;
    /** 0 (trivial) … 4 (extreme), continuous */
    difficulty: number;
    /** 0..1 probability that a subtle mistake is costly */
    stakes: number;
    source: 'jev' | 'heuristic';
}
export interface StepSignals {
    phase: Phase;
    phaseConfidence: number;
    /** 0 … 4, how hard the next step is */
    stepDifficulty: number;
    /** 0..1 */
    stuck: number;
    source: 'jev' | 'heuristic';
}
export interface ToolCallSummary {
    tool: string;
    /** one-line rendering of the input, e.g. the Bash command or file path */
    summary: string;
    failed: boolean;
    /** truncated result or error text */
    result: string;
}
export interface StepContext {
    prompt: string;
    profile: TaskProfile;
    turn: number;
    current: Effort;
    consecutiveFailures: number;
    /** latest assistant text in this prompt (what it said it's doing) */
    assistantNote: string;
    lastBatch: ToolCallSummary[];
    /** compact one-liners of earlier batches, oldest first */
    trajectory: string[];
}
export interface EffortDecision {
    kind: 'task' | 'step';
    effort: Effort;
    previous: Effort | null;
    changed: boolean;
    reasons: string[];
    /** 'local' = the policy gate decided no Jev call could change the outcome */
    source: 'jev' | 'heuristic' | 'pinned' | 'local';
    jevLatencyMs: number;
    jevError?: string;
    profile?: TaskProfile;
    signals?: StepSignals;
    policyVersion?: string;
    /** versions of the Jev question sets this decision could draw on */
    questionVersions?: {
        task?: string;
        step?: string;
    };
}
