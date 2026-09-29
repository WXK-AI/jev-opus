import fs from 'node:fs';
import path from 'node:path';
import { auditIssues, reviveCore } from '../router/state.js';
import { foldJournal, readJournalFile } from './journal.js';
/**
 * Open issues after a decision. Decisions journaled before evidence was
 * recorded fall back to their router snapshot, which has the issues but not
 * their cause or originating tool call.
 */
function openIssues(d) {
    if (d.decision?.evidence)
        return { issues: d.decision.evidence.open, legacy: false };
    const snap = d.routerSnapshot;
    const core = d.kind === 'step' && !d.manual && snap?.v === 2 ? reviveCore(snap.state) : null;
    return { issues: core ? auditIssues(core) : [], legacy: true };
}
/** Open reasoning issues: the evidence that can block stepping effort down. */
function holdingIssues(d) {
    return openIssues(d).issues.filter((i) => !i.environment);
}
/** Open issues actually kept effort from stepping down on this decision. */
function heldByIssues(d) {
    if (d.kind !== 'step' || d.manual)
        return false;
    if (d.decision?.evidence)
        return d.decision.evidence.heldByIssues === true;
    return d.decision?.reasons.some((r) => /unresolved issue\(s\) → hold/.test(r)) === true && d.requested === d.current;
}
/**
 * Read-only export. Filters match a journal filename or a full/short decision
 * ID; `holds` keeps only decisions where open issues kept effort from stepping
 * down.
 */
export function auditJournal(dir, filter = '', opts = {}) {
    let files;
    try {
        files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]+\.jsonl$/.test(f)).sort();
    }
    catch (err) {
        if (err.code === 'ENOENT')
            files = [];
        else
            throw err;
    }
    const query = filter.replace(/^D-/i, '').toLowerCase();
    const journals = files.map((file) => {
        const events = readJournalFile(path.join(dir, file));
        const decisions = foldJournal(events)
            .filter((d) => !query || file.startsWith(query) || d.decisionId.toLowerCase().startsWith(query))
            .filter((d) => !opts.holds || heldByIssues(d));
        const ids = new Set(decisions.map((d) => d.decisionId));
        return { journal: file, decisions, events: events.filter((e) => ids.has(e.decisionId)) };
    }).filter((j) => j.decisions.length);
    const decisions = journals.flatMap((j) => j.decisions);
    const attempts = decisions.flatMap((d) => d.attempts ?? []);
    return {
        schemaVersion: 2,
        summary: {
            decisions: decisions.length, attempts: attempts.length,
            observedOutputTokens: decisions.reduce((n, d) => n + (d.usage?.outputTokens ?? 0), 0),
            incompleteAttempts: attempts.filter((a) => a.usageComplete !== true).length,
            legacyDecisions: decisions.filter((d) => !d.decision).length,
            efforts: tally(decisions.map((d) => d.requested)),
            holds: holdSummary(decisions),
        },
        journals,
    };
}
function tally(values) {
    const out = {};
    for (const v of values)
        out[v] = (out[v] ?? 0) + 1;
    return out;
}
/** Decisions whose open reasoning issues could hold effort, grouped by the cause that opened them. */
function holdSummary(decisions) {
    const held = decisions.filter((d) => holdingIssues(d).length > 0);
    const issues = new Map();
    for (const d of held)
        for (const i of holdingIssues(d))
            issues.set(i.id, i);
    const blocked = held.filter(heldByIssues);
    return {
        /** decisions with open reasoning issues */
        decisions: held.length,
        /** decisions where those issues kept effort from stepping down */
        blocked: blocked.length,
        /** of those, decisions that kept high, xhigh, or max in force */
        blockedAtHighOrAbove: blocked.filter((d) => ['high', 'xhigh', 'max'].includes(d.requested)).length,
        issues: issues.size,
        byCause: tally([...issues.values()].map((i) => i.cause ?? 'unrecorded')),
    };
}
const CLEARS = {
    'check-passes': 'clears when the same check passes',
    'command-succeeds': 'clears when the same command succeeds',
};
function formatIssue(i, legacy) {
    const origin = i.toolId ? ` from ${i.toolId}` : '';
    const steps = (n) => `${n} step${n === 1 ? '' : 's'}`;
    // Legacy snapshots know when an issue last failed, not when it opened.
    const age = legacy ? (i.age === 0 ? 'failed this step' : `last failed ${steps(i.age)} ago`) : i.age === 0 ? 'opened this step' : `open ${steps(i.age)}`;
    const tried = i.tried.length ? ` at ${i.tried.join('/')}` : '';
    return `  open I-${i.id} · ${i.cause ?? 'cause unrecorded'}${origin} · ${age} · ${i.attempts} failed run${i.attempts === 1 ? '' : 's'}${tried}${i.environment ? ' · environment blocker (never holds)' : ''} · ${CLEARS[i.clears]}`;
}
export function formatAudit(report) {
    const lines = report.journals.flatMap((j) => j.decisions.map((d) => {
        const transition = d.current === d.requested ? d.requested.toUpperCase() : `${d.current.toUpperCase()} → ${d.requested.toUpperCase()}`;
        const out = [`D-${d.decisionId.slice(0, 8)} · ${transition} · ${d.attempts?.length ?? 0} attempts (${d.attempts?.map((a) => a.status).join(', ') || 'legacy'}) · ${d.usage?.outputTokens ?? '?'} observed output tokens`,
            `  ${d.decision?.reasons.join('; ') ?? 'Legacy record: explanation unavailable'}`];
        const ev = d.decision?.evidence;
        if (ev?.observed.length) {
            out.push(`  observed: ${ev.observed.map((o) => `${o.toolId ?? o.tool} ${o.kind ? `${o.kind} ` : ''}${o.outcome}${o.cause ? ` (${o.cause})` : ''}`).join('; ')}`);
        }
        const open = openIssues(d);
        if (heldByIssues(d))
            out.push(`  held at ${d.requested.toUpperCase()}: the open issues below blocked a step down`);
        for (const i of open.issues)
            out.push(formatIssue(i, open.legacy));
        return out.join('\n');
    }));
    if (!lines.length)
        return 'No matching audit records.';
    const s = report.summary;
    lines.push(`Efforts: ${Object.entries(s.efforts).map(([e, n]) => `${e} ${n}`).join(', ')}.`);
    if (s.holds.decisions) {
        lines.push(`${s.holds.decisions} decisions had open reasoning issues; in ${s.holds.blocked} they kept effort from stepping down (${s.holds.blockedAtHighOrAbove} at high or above). ${s.holds.issues} issues: ${Object.entries(s.holds.byCause).map(([c, n]) => `${c} ${n}`).join(', ')}.`);
    }
    lines.push(`${s.incompleteAttempts} attempts with incomplete usage; ${s.legacyDecisions} legacy decisions without full attribution.`);
    return lines.join('\n');
}
