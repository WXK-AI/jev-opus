import type { Effort } from '../effort.ts';
import type { Phase, TaskType } from './questions.ts';

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
  source: 'jev' | 'heuristic' | 'pinned';
  jevLatencyMs: number;
  jevError?: string;
  profile?: TaskProfile;
  signals?: StepSignals;
}
