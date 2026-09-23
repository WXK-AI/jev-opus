import { heuristicStepSignals, heuristicTaskProfile } from './heuristics.js';
import { applyHysteresis, stepTarget, taskEffort } from './policy.js';
import { STEP_QUESTIONS, TASK_QUESTIONS } from './questions.js';
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`);
function choice(a) {
    return a?.kind === 'choice' ? { value: a.choice, confidence: a.confidence } : { value: '', confidence: 0 };
}
function score(a, fallback) {
    return a?.kind === 'score' ? a.score : fallback;
}
function noul(a, fallback) {
    return a?.kind === 'noul' ? a.p : fallback;
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
    constructor(opts) {
        this.jev = opts.jev && opts.jev.enabled ? opts.jev : null;
        this.bounds = opts.bounds;
        this.pinned = opts.pinned ?? null;
    }
    get usingJev() {
        return this.jev !== null;
    }
    async routeTask(prompt, previous, conversationNote) {
        if (this.pinned)
            return this.pinnedDecision('task', previous);
        let profile = heuristicTaskProfile(prompt);
        let jevLatencyMs = 0;
        let jevError;
        if (this.jev) {
            const res = await this.jev.ask(taskState(prompt, conversationNote), TASK_QUESTIONS);
            jevLatencyMs = res.latencyMs;
            if (res.failed)
                jevError = res.error;
            else {
                const t = choice(res.answers.task_type);
                profile = {
                    taskType: (t.value || profile.taskType),
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
    async routeStep(ctx) {
        if (this.pinned)
            return this.pinnedDecision('step', ctx.current);
        let signals = heuristicStepSignals(ctx);
        let jevLatencyMs = 0;
        let jevError;
        if (this.jev) {
            const res = await this.jev.ask(stepState(ctx), STEP_QUESTIONS);
            jevLatencyMs = res.latencyMs;
            if (res.failed)
                jevError = res.error;
            else {
                const ph = choice(res.answers.phase);
                signals = {
                    phase: (ph.value || signals.phase),
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
    /** Profile of the task being worked on, for building step contexts. */
    lastProfileFallback(prompt) {
        return heuristicTaskProfile(prompt);
    }
    pinnedDecision(kind, previous) {
        const effort = this.pinned;
        return { kind, effort, previous, changed: effort !== previous, reasons: ['pinned'], source: 'pinned', jevLatencyMs: 0 };
    }
}
