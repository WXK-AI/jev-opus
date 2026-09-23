import { clampEffort, fromRank, rank } from '../effort.js';
const LOW = 0, MEDIUM = 1, HIGH = 2, XHIGH = 3, MAX = 4;
export function difficultyRank(d) {
    if (d < 1.25)
        return LOW;
    if (d < 2.25)
        return MEDIUM;
    if (d < 3.1)
        return HIGH;
    return XHIGH;
}
export function taskEffort(p, bounds) {
    const reasons = [];
    let r = difficultyRank(p.difficulty);
    reasons.push(`difficulty ${p.difficulty.toFixed(1)}/4 → ${fromRank(r)}`);
    // Only trust the task type enough to cap/floor when Jev is reasonably sure.
    if (p.source === 'heuristic' || p.typeConfidence >= 0.35) {
        const cap = p.taskType === 'chat' || p.taskType === 'factual' ? MEDIUM
            : p.taskType === 'writing' || p.taskType === 'code_small' ? HIGH
                : MAX;
        // Floors lift underestimated work, not genuinely trivial asks ("what's 2+2").
        const floor = p.difficulty >= 0.75 && ['debugging', 'architecture', 'math_logic', 'code_feature'].includes(p.taskType) ? MEDIUM : LOW;
        if (r > cap) {
            r = cap;
            reasons.push(`${p.taskType} capped at ${fromRank(cap)}`);
        }
        if (r < floor) {
            r = floor;
            reasons.push(`${p.taskType} floor ${fromRank(floor)}`);
        }
    }
    if (p.stakes >= 0.7 && p.difficulty >= 1.5) {
        const before = r;
        r = Math.max(r + 1, HIGH);
        if (r !== before)
            reasons.push(`high stakes (${p.stakes.toFixed(2)}) → ${fromRank(r)}`);
    }
    const extreme = p.difficulty >= 3.6 && (p.stakes >= 0.7 || p.taskType === 'math_logic' || p.taskType === 'architecture');
    if (extreme) {
        r = MAX;
        reasons.push('extreme + critical → max');
    }
    else
        r = Math.min(r, XHIGH);
    const effort = clampEffort(fromRank(r), bounds.min, bounds.max);
    if (effort !== fromRank(r))
        reasons.push(`bounded to ${effort}`);
    return { effort, reasons };
}
export function stepTarget(base, s, consecutiveFailures, bounds) {
    const reasons = [];
    const b = rank(base);
    let r = b;
    const trustPhase = s.source === 'heuristic' || s.phaseConfidence >= 0.3;
    if (trustPhase) {
        switch (s.phase) {
            case 'exploring':
                r = b - 1;
                reasons.push('exploring → -1');
                break;
            case 'implementing':
                reasons.push('implementing → task level');
                break;
            case 'diagnosing':
                r = b + 1;
                reasons.push('diagnosing → +1');
                break;
            case 'verifying':
                r = b - 1;
                reasons.push('verifying → -1');
                break;
            case 'finishing':
                r = Math.min(b - 1, MEDIUM);
                reasons.push('finishing → ≤ medium');
                break;
        }
    }
    else {
        reasons.push(`phase unclear (${s.phaseConfidence.toFixed(2)}) → task level`);
    }
    if (s.stepDifficulty >= 3.25 && r < HIGH) {
        r = HIGH;
        reasons.push(`hard step ${s.stepDifficulty.toFixed(1)} → high`);
    }
    else if (s.stepDifficulty >= 2.4 && r < MEDIUM) {
        r = MEDIUM;
        reasons.push(`step ${s.stepDifficulty.toFixed(1)} → medium`);
    }
    else if (s.stepDifficulty <= 0.75 && s.phase !== 'implementing' && s.phase !== 'diagnosing' && r > LOW) {
        r = Math.max(LOW, r - 1);
        reasons.push(`trivial step ${s.stepDifficulty.toFixed(1)} → -1`);
    }
    if (consecutiveFailures >= 1 && s.phase !== 'diagnosing') {
        r += 1;
        reasons.push(`${consecutiveFailures} failed call(s) → +1`);
    }
    const stuck = s.stuck >= 0.7 || consecutiveFailures >= 3;
    let cap = XHIGH;
    if (stuck) {
        // Raising works best as a large jump: go at least two levels up, at least high.
        r = Math.max(r, b + 2, HIGH);
        reasons.push(`stuck (${s.stuck.toFixed(2)}, ${consecutiveFailures} fails) → escalate`);
        if (consecutiveFailures >= 4 || s.stuck >= 0.9)
            cap = MAX;
    }
    if (b === MAX)
        cap = MAX;
    // Never drift more than two levels under the task's own level.
    r = Math.max(r, b - 2, LOW);
    r = Math.min(r, cap);
    const effort = clampEffort(fromRank(r), bounds.min, bounds.max);
    if (effort !== fromRank(r))
        reasons.push(`bounded to ${effort}`);
    return { effort, reasons };
}
/**
 * Anti-flapping: raises apply at once; after a raise the level is held for
 * one more step; decreases step down one level at a time (except when the
 * work is finishing, which drops straight to the target).
 */
export function applyHysteresis(current, target, hold, finishing) {
    const c = rank(current), t = rank(target);
    if (t > c)
        return { effort: target, hold: 1 };
    if (t === c)
        return { effort: current, hold: Math.max(0, hold - 1) };
    if (hold > 0 && !finishing)
        return { effort: current, hold: hold - 1, note: `holding ${current} after escalation` };
    if (finishing)
        return { effort: target, hold: 0 };
    const next = fromRank(c - 1);
    return { effort: next, hold: 0, note: next !== target ? `stepping down toward ${target}` : undefined };
}
