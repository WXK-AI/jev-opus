import { isEffort, type Effort } from '../effort.ts';
import type { JevAnswer, JevLike } from '../jev/client.ts';
import { heuristicStepSignals, heuristicTaskProfile } from './heuristics.ts';
import { applyHysteresis, stepTarget, taskEffort, type Bounds } from './policy.ts';
import { STEP_QUESTIONS, TASK_QUESTIONS, type Phase, type TaskType } from './questions.ts';
import type { EffortDecision, StepContext, StepSignals, TaskProfile } from './types.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`);

function choice(a: JevAnswer | undefined): { value: string; confidence: number } {
  return a?.kind === 'choice' ? { value: a.choice, confidence: a.confidence } : { value: '', confidence: 0 };
}
function score(a: JevAnswer | undefined, fallback: number): number {
  return a?.kind === 'score' ? a.score : fallback;
}
function noul(a: JevAnswer | undefined, fallback: number): number {
  return a?.kind === 'noul' ? a.p : fallback;
}

export function taskState(prompt: string, conversationNote?: string): string {
  let s = `USER REQUEST TO A CODING AGENT:\n${clip(prompt.trim(), 3000)}`;
  if (conversationNote) s += `\n\nEARLIER IN THIS CONVERSATION (context only):\n${clip(conversationNote, 800)}`;
  return s;
}

export function stepState(ctx: StepContext): string {
  const lines = [
    `TASK (${ctx.profile.taskType}, difficulty ${ctx.profile.difficulty.toFixed(1)}/4): ${clip(ctx.prompt.trim(), 1200)}`,
    `STEP ${ctx.turn} · effort in force: ${ctx.current} · consecutive failed tool calls: ${ctx.consecutiveFailures}`,
  ];
  if (ctx.assistantNote) lines.push(`AGENT SAID: ${clip(ctx.assistantNote.trim(), 500)}`);
  lines.push('TOOL CALLS JUST MADE:');
  for (const c of ctx.lastBatch) {
    lines.push(`- ${c.tool} ${clip(c.summary, 200)} → ${c.failed ? 'FAILED' : 'ok'}: ${clip(c.result.replace(/\s+/g, ' '), 400)}`);
  }
  if (ctx.trajectory.length) lines.push(`EARLIER STEPS:\n${ctx.trajectory.slice(-6).join('\n')}`);
  return lines.join('\n');
}

export interface RouterSnapshot {
  v: number;
  [key: string]: unknown;
}

export class EffortRouter {
  private readonly jev: JevLike | null;
  bounds: Bounds;
  pinned: Effort | null;
  private hold = 0;
  private base: Effort = 'medium';

  constructor(opts: { jev: JevLike | null; bounds: Bounds; pinned?: Effort | null }) {
    this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
    this.bounds = opts.bounds;
    this.pinned = opts.pinned ?? null;
  }

  get usingJev(): boolean {
    return this.jev !== null;
  }

  async routeTask(prompt: string, previous: Effort | null, conversationNote?: string): Promise<EffortDecision> {
    if (this.pinned) return this.pinnedDecision('task', previous);

    let profile: TaskProfile = heuristicTaskProfile(prompt);
    let jevLatencyMs = 0;
    let jevError: string | undefined;
    if (this.jev) {
      const res = await this.jev.ask(taskState(prompt, conversationNote), TASK_QUESTIONS);
      jevLatencyMs = res.latencyMs;
      if (res.failed) jevError = res.error;
      else {
        const t = choice(res.answers.task_type);
        profile = {
          taskType: (t.value || profile.taskType) as TaskType,
          typeConfidence: t.confidence,
          difficulty: score(res.answers.difficulty, profile.difficulty),
          stakes: noul(res.answers.stakes, profile.stakes),
          source: 'jev',
        };
      }
    }

    const { effort, reasons } = taskEffort(profile, this.bounds);
    this.base = effort;
    this.hold = 0; // a new prompt is a fresh decision, no carried-over hold
    return {
      kind: 'task', effort, previous, changed: effort !== previous, reasons,
      source: profile.source, jevLatencyMs, jevError, profile,
    };
  }

  async routeStep(ctx: StepContext): Promise<EffortDecision> {
    if (this.pinned) return this.pinnedDecision('step', ctx.current);

    let signals: StepSignals = heuristicStepSignals(ctx);
    let jevLatencyMs = 0;
    let jevError: string | undefined;
    if (this.jev) {
      const res = await this.jev.ask(stepState(ctx), STEP_QUESTIONS);
      jevLatencyMs = res.latencyMs;
      if (res.failed) jevError = res.error;
      else {
        const ph = choice(res.answers.phase);
        signals = {
          phase: (ph.value || signals.phase) as Phase,
          phaseConfidence: ph.confidence,
          stepDifficulty: score(res.answers.step_difficulty, signals.stepDifficulty),
          stuck: noul(res.answers.stuck, signals.stuck),
          source: 'jev',
        };
      }
    }

    const target = stepTarget(this.base, signals, ctx.consecutiveFailures, this.bounds);
    const h = applyHysteresis(ctx.current, target.effort, this.hold, signals.phase === 'finishing');
    this.hold = h.hold;
    const reasons = h.note ? [...target.reasons, h.note] : target.reasons;
    return {
      kind: 'step', effort: h.effort, previous: ctx.current, changed: h.effort !== ctx.current, reasons,
      source: signals.source, jevLatencyMs, jevError, signals, profile: ctx.profile,
    };
  }

  /**
   * JSON-serializable controller state, so an adapter can persist it with a
   * decision and restore the common-ancestor state after a rewind or restart.
   * Adapters must treat the value as opaque.
   */
  snapshot(): RouterSnapshot {
    return { v: 1, hold: this.hold, base: this.base };
  }

  restore(s: RouterSnapshot): void {
    if (!s || s.v !== 1) return;
    this.hold = Number(s.hold) || 0;
    this.base = isEffort(s.base) ? s.base : this.base;
  }

  /** Profile of the task being worked on, for building step contexts. */
  lastProfileFallback(prompt: string): TaskProfile {
    return heuristicTaskProfile(prompt);
  }

  private pinnedDecision(kind: 'task' | 'step', previous: Effort | null): EffortDecision {
    const effort = this.pinned!;
    return { kind, effort, previous, changed: effort !== previous, reasons: ['pinned'], source: 'pinned', jevLatencyMs: 0 };
  }
}
