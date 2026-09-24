import { clampEffort, fromRank, rank, type Effort } from '../effort.ts';
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
export const POLICY_VERSION = 'policy.v2';

/** Misordered bounds are a configuration error: swap them rather than crash. */
export function normalizeBounds(b: Bounds): Bounds {
  return rank(b.min) <= rank(b.max) ? b : { min: b.max, max: b.min };
}

const LOW = 0, MEDIUM = 1, HIGH = 2, XHIGH = 3, MAX = 4;

export function difficultyRank(d: number): number {
  if (d < 1.25) return LOW;
  if (d < 2.25) return MEDIUM;
  if (d < 3.1) return HIGH;
  return XHIGH;
}

export function taskEffort(p: TaskProfile, bounds: Bounds): { effort: Effort; reasons: string[] } {
  const reasons: string[] = [];
  let r = difficultyRank(p.difficulty);
  reasons.push(`difficulty ${p.difficulty.toFixed(1)}/4 → ${fromRank(r)}`);

  // Only trust the task type enough to cap/floor when Jev is reasonably sure.
  if (p.source === 'heuristic' || p.typeConfidence >= 0.35) {
    const cap = p.taskType === 'chat' || p.taskType === 'factual' ? MEDIUM
      : p.taskType === 'writing' || p.taskType === 'code_small' ? HIGH
        : MAX;
    // Floors lift underestimated work, not genuinely trivial asks ("what's 2+2").
    const floor = p.difficulty >= 0.75 && ['debugging', 'architecture', 'math_logic', 'code_feature'].includes(p.taskType) ? MEDIUM : LOW;
    if (r > cap) { r = cap; reasons.push(`${p.taskType} capped at ${fromRank(cap)}`); }
    if (r < floor) { r = floor; reasons.push(`${p.taskType} floor ${fromRank(floor)}`); }
  }

  if (p.stakes >= 0.7 && p.difficulty >= 1.5) {
    const before = r;
    r = Math.max(r + 1, HIGH);
    if (r !== before) reasons.push(`high stakes (${p.stakes.toFixed(2)}) → ${fromRank(r)}`);
  }

  const extreme = p.difficulty >= 3.6 && (p.stakes >= 0.7 || p.taskType === 'math_logic' || p.taskType === 'architecture');
  if (extreme) { r = MAX; reasons.push('extreme + critical → max'); }
  else r = Math.min(r, XHIGH);

  const nb = normalizeBounds(bounds);
  const effort = clampEffort(fromRank(r), nb.min, nb.max);
  if (effort !== fromRank(r)) reasons.push(`bounded to ${effort}`);
  return { effort, reasons };
}

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

export function stepTarget(
  base: Effort,
  s: StepSignals,
  ev: StepEvidence,
  current: Effort,
): { effort: Effort; reasons: string[] } {
  const reasons: string[] = [];
  const b = rank(base);
  const c = rank(current);
  let r = b;

  const trustPhase = s.source === 'heuristic' || s.phaseConfidence >= 0.3;
  if (trustPhase) {
    switch (s.phase) {
      case 'exploring': r = b - 1; reasons.push('exploring → -1'); break;
      case 'implementing': reasons.push('implementing → task level'); break;
      case 'diagnosing': r = b + 1; reasons.push('diagnosing → +1'); break;
      case 'verifying': r = b - 1; reasons.push('verifying → -1'); break;
      case 'finishing': r = Math.min(b - 1, MEDIUM); reasons.push('finishing → ≤ medium'); break;
    }
  } else {
    reasons.push(`phase unclear (${s.phaseConfidence.toFixed(2)}) → task level`);
  }

  if (s.stepDifficulty >= 3.25 && r < HIGH) { r = HIGH; reasons.push(`hard step ${s.stepDifficulty.toFixed(1)} → high`); }
  else if (s.stepDifficulty >= 2.4 && r < MEDIUM) { r = MEDIUM; reasons.push(`step ${s.stepDifficulty.toFixed(1)} → medium`); }
  else if (s.stepDifficulty <= 0.75 && s.phase !== 'implementing' && s.phase !== 'diagnosing' && r > LOW) {
    r = Math.max(LOW, r - 1); reasons.push(`trivial step ${s.stepDifficulty.toFixed(1)} → -1`);
  }

  // Failures escalate relative to the effort already tried on them, never the
  // initial estimate: a repeated unresolved failure goes one level above the
  // highest effort that has already failed on that issue.
  if (ev.triedOnFailure.length) {
    const tried = Math.max(c, ...ev.triedOnFailure.map(rank));
    const floor = tried + 1;
    if (r < floor) {
      r = floor;
      reasons.push(ev.repeated
        ? `same failure already lost at ${fromRank(tried)} → ${fromRank(floor)}`
        : `failed step → ${fromRank(floor)}`);
    }
  }

  const stuck = s.stuck >= 0.7 || ev.maxAttempts >= 3;
  if (stuck && ev.unresolved > 0) {
    // Raising works best as a large jump: go at least two levels up, at least high.
    r = Math.max(r, b + 2, HIGH);
    reasons.push(`stuck (${s.stuck.toFixed(2)}, ${ev.maxAttempts} attempts) → escalate`);
  }

  // Environment blockers hold the current effort; they never drive escalation.
  if (ev.environmentOnly) {
    if (r !== c) reasons.push('environment blocker → hold');
    r = c;
  }

  // De-escalation needs positive evidence: no unresolved reasoning issues and
  // a routine next step. A successful read or a finishing phase alone never
  // lowers effort while an issue remains open.
  if (r < c) {
    if (ev.unresolved > 0) {
      r = c;
      reasons.push(`${ev.unresolved} unresolved issue(s) → hold ${current}`);
    } else if (s.phase === 'diagnosing' || !ev.routineOk) {
      r = c;
      reasons.push('no routine evidence → hold');
    }
  }

  // Never drift more than two levels under the task's own level.
  r = Math.max(r, b - 2, LOW);

  let cap = XHIGH;
  const triedMax = ev.triedOnFailure.length ? Math.max(...ev.triedOnFailure.map(rank)) : -1;
  if (triedMax >= XHIGH || (ev.unresolved > 0 && s.stuck >= 0.9)) cap = MAX;
  if (b === MAX || c === MAX) cap = MAX;
  r = Math.min(r, cap);

  return { effort: fromRank(r), reasons };
}

/**
 * Anti-flapping: raises apply at once; after a raise the level is held for
 * one more step; decreases step down one level at a time (except when the
 * work is finishing, which drops straight to the target).
 */
export function applyHysteresis(
  current: Effort,
  target: Effort,
  hold: number,
  finishing: boolean,
): { effort: Effort; hold: number; note?: string } {
  const c = rank(current), t = rank(target);
  if (t > c) return { effort: target, hold: 1 };
  if (t === c) return { effort: current, hold: Math.max(0, hold - 1) };
  if (hold > 0 && !finishing) return { effort: current, hold: hold - 1, note: `holding ${current} after escalation` };
  if (finishing) return { effort: target, hold: 0 };
  const next = fromRank(c - 1);
  return { effort: next, hold: 0, note: next !== target ? `stepping down toward ${target}` : undefined };
}
