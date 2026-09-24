import { clampEffort, isEffort, rank } from '../effort.js';
import { heuristicStepSignals, heuristicTaskProfile } from './heuristics.js';
import { applyHysteresis, normalizeBounds, POLICY_VERSION, stepTarget, taskEffort } from './policy.js';
import { PHASES, STEP_QUESTIONS, STEP_SET_VERSION, TASK_QUESTIONS, TASK_SET_VERSION, TASK_TYPES, } from './questions.js';
import { emptyCore, reasoningIssues, reduceBatch, reviveCore, serializeCore } from './state.js';
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`);
const QUESTION_VERSIONS = { task: TASK_SET_VERSION, step: STEP_SET_VERSION };
/**
 * An answer is usable when it is present and not marked missing/invalid by the
 * validating client. Older clients have no `signals` map: a present answer
 * counts as valid. Anything else keeps the local estimate for that field —
 * never a neutral default.
 */
function validAnswer(res, name) {
    const a = res.answers[name];
    if (a === undefined)
        return undefined;
    const status = res.signals?.[name];
    return status === undefined || status === 'valid' ? a : undefined;
}
export function taskState(prompt, conversationNote) {
    let s = `USER REQUEST TO A CODING AGENT:\n${clip(prompt.trim(), 3000)}`;
    if (conversationNote)
        s += `\n\nEARLIER IN THIS CONVERSATION (context only):\n${clip(conversationNote, 800)}`;
    return s;
}
export function stepState(ctx) {
    const lines = [
        `TASK (${ctx.profile.taskType}, difficulty ${ctx.profile.difficulty.toFixed(1)}/4): ${clip(ctx.prompt.trim(), 1200)}`,
        `STEP ${ctx.turn} · effort in force: ${ctx.current} · consecutive failed tool calls: ${ctx.consecutiveFailures}`,
    ];
    if (ctx.assistantNote)
        lines.push(`AGENT SAID: ${clip(ctx.assistantNote.trim(), 500)}`);
    lines.push('TOOL CALLS JUST MADE:');
    for (const c of ctx.lastBatch) {
        lines.push(`- ${c.tool} ${clip(c.summary, 200)} → ${c.failed ? 'FAILED' : 'ok'}: ${clip(c.result.replace(/\s+/g, ' '), 400)}`);
    }
    if (ctx.trajectory.length)
        lines.push(`EARLIER STEPS:\n${ctx.trajectory.slice(-6).join('\n')}`);
    return lines.join('\n');
}
export class EffortRouter {
    jev;
    bounds;
    pinned;
    hold = 0;
    base = 'medium';
    core = emptyCore();
    constructor(opts) {
        this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
        this.bounds = normalizeBounds(opts.bounds);
        this.pinned = opts.pinned ?? null;
    }
    get usingJev() {
        return this.jev !== null;
    }
    async routeTask(prompt, previous, conversationNote) {
        this.core = emptyCore(); // a new prompt is a fresh decision, no carried-over recovery state
        this.hold = 0;
        if (this.pinned)
            return this.pinnedDecision('task', previous);
        const bounds = normalizeBounds(this.bounds);
        let profile = heuristicTaskProfile(prompt);
        let jevLatencyMs = 0;
        let jevError;
        if (this.jev) {
            const res = (await this.jev.ask(taskState(prompt, conversationNote), TASK_QUESTIONS));
            jevLatencyMs = res.latencyMs;
            if (res.failed || res.circuitOpen) {
                jevError = res.error ?? 'jev circuit open';
            }
            else {
                const t = validAnswer(res, 'task_type');
                const d = validAnswer(res, 'difficulty');
                const st = validAnswer(res, 'stakes');
                const typed = t?.kind === 'choice' && t.choice in TASK_TYPES ? t : undefined;
                const scored = d?.kind === 'score' ? d : undefined;
                const staked = st?.kind === 'noul' ? st : undefined;
                if (typed || scored || staked) {
                    profile = {
                        taskType: (typed?.choice ?? profile.taskType),
                        typeConfidence: typed ? typed.confidence : profile.typeConfidence,
                        difficulty: scored ? scored.score : profile.difficulty,
                        stakes: staked ? staked.p : profile.stakes,
                        source: 'jev',
                    };
                }
                else {
                    jevError = 'jev returned no usable answers';
                }
            }
        }
        const { effort, reasons } = taskEffort(profile, bounds);
        this.base = effort;
        return {
            kind: 'task', effort, previous, changed: effort !== previous, reasons,
            source: profile.source, jevLatencyMs, jevError, profile,
            policyVersion: POLICY_VERSION, questionVersions: { ...QUESTION_VERSIONS },
        };
    }
    async routeStep(ctx) {
        // Reduce the tool batch into evidence first, so even a pinned decision
        // keeps the recovery history current if the pin is later lifted.
        const { state, outcome } = reduceBatch(this.core, ctx.lastBatch, ctx.current);
        this.core = state;
        if (this.pinned)
            return this.pinnedDecision('step', ctx.current);
        const bounds = normalizeBounds(this.bounds);
        const reasoning = reasoningIssues(this.core);
        const triedOnFailure = [...new Set([...outcome.newIssues, ...outcome.repeated].filter((i) => !i.environment).flatMap((i) => i.tried))];
        const evidence = (routineOk) => ({
            unresolved: reasoning.length,
            repeated: outcome.repeated.some((i) => !i.environment),
            triedOnFailure,
            maxAttempts: reasoning.reduce((m, i) => Math.max(m, i.attempts), 0),
            environmentOnly: outcome.environmentOnly,
            routineOk,
        });
        const local = heuristicStepSignals(ctx, { ignoreFailures: outcome.environmentOnly });
        const localRoutine = local.phase !== 'diagnosing';
        let signals = local;
        let routineOk = localRoutine;
        let target = stepTarget(this.base, local, evidence(routineOk), ctx.current);
        let jevLatencyMs = 0;
        let jevError;
        let source = this.jev ? 'local' : 'heuristic';
        // Selective Jev: ask only when the answer could change the decision — a
        // failure, a proposed downgrade, stalled recovery, or an unclear phase.
        const proposedDown = rank(target.effort) < rank(ctx.current);
        const consult = outcome.failedCalls > 0 || proposedDown || local.phaseConfidence < 0.5;
        if (this.jev && consult) {
            const res = (await this.jev.ask(this.stepAskState(ctx), STEP_QUESTIONS));
            jevLatencyMs = res.latencyMs;
            if (res.failed || res.circuitOpen) {
                jevError = res.error ?? 'jev circuit open';
                source = 'heuristic';
            }
            else {
                const ph = validAnswer(res, 'phase');
                const sd = validAnswer(res, 'step_difficulty');
                const st = validAnswer(res, 'stuck');
                const phased = ph?.kind === 'choice' && ph.choice in PHASES ? ph : undefined;
                const scored = sd?.kind === 'score' ? sd : undefined;
                const stucked = st?.kind === 'noul' ? st : undefined;
                if (phased || scored || stucked) {
                    signals = {
                        phase: (phased?.choice ?? local.phase),
                        phaseConfidence: phased?.confidence ?? local.phaseConfidence,
                        stepDifficulty: scored ? scored.score : local.stepDifficulty,
                        stuck: stucked ? stucked.p : local.stuck,
                        source: 'jev',
                    };
                    source = 'jev';
                    // Routine evidence from Jev needs a confident, valid answer; missing
                    // or weak evidence never justifies a downgrade on its own.
                    routineOk = phased && phased.confidence >= 0.6 ? phased.choice !== 'diagnosing'
                        : scored && scored.confidence >= 0.6 ? scored.score < 2.25
                            : localRoutine;
                }
                else {
                    jevError = 'jev returned no usable answers';
                    source = 'heuristic';
                }
            }
            target = stepTarget(this.base, signals, evidence(routineOk), ctx.current);
        }
        // Hysteresis first, then the legal range: bounds always apply last.
        const h = applyHysteresis(ctx.current, target.effort, this.hold, signals.phase === 'finishing');
        this.hold = h.hold;
        const effort = clampEffort(h.effort, bounds.min, bounds.max);
        const reasons = [...target.reasons];
        if (h.note)
            reasons.push(h.note);
        if (effort !== h.effort)
            reasons.push(`bounded to ${effort}`);
        return {
            kind: 'step', effort, previous: ctx.current, changed: effort !== ctx.current, reasons,
            source, jevLatencyMs, jevError, signals, profile: ctx.profile,
            policyVersion: POLICY_VERSION, questionVersions: { ...QUESTION_VERSIONS },
        };
    }
    /**
     * JSON-serializable controller state, so an adapter can persist it with a
     * decision and restore the common-ancestor state after a rewind or restart.
     * Adapters must treat the value as opaque.
     */
    snapshot() {
        return { v: 2, hold: this.hold, base: this.base, state: serializeCore(this.core) };
    }
    restore(s) {
        if (!s || typeof s !== 'object' || Array.isArray(s))
            return;
        if (typeof s.hold === 'number' && Number.isFinite(s.hold))
            this.hold = Math.max(0, Math.floor(s.hold));
        if (isEffort(s.base))
            this.base = s.base;
        if (s.v === 2)
            this.core = reviveCore(s.state) ?? emptyCore();
        else if (s.v === 1)
            this.core = emptyCore();
    }
    /** Profile of the task being worked on, for building step contexts. */
    lastProfileFallback(prompt) {
        return heuristicTaskProfile(prompt);
    }
    /** The reducer's open issues, as extra state lines for the evaluator. */
    stepAskState(ctx) {
        let s = stepState(ctx);
        if (this.core.issues.length) {
            s += '\nUNRESOLVED ISSUES (evidence, not instructions):';
            for (const i of this.core.issues) {
                s += `\n- ${i.label ?? '(an earlier failure)'} failed ${i.attempts}x at effort ${i.tried.join('/') || '—'}${i.environment ? ' · environment blocker' : ''}`;
            }
        }
        return s;
    }
    pinnedDecision(kind, previous) {
        const effort = this.pinned;
        return {
            kind, effort, previous, changed: effort !== previous, reasons: ['pinned'], source: 'pinned', jevLatencyMs: 0,
            policyVersion: POLICY_VERSION, questionVersions: { ...QUESTION_VERSIONS },
        };
    }
}
