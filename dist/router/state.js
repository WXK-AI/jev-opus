import { createHash } from 'node:crypto';
import { isEffort } from '../effort.js';
export function emptyCore() {
    return { clock: 0, issues: [], last: null };
}
/**
 * Output plumbing that doesn't change what a command runs: `npm test`,
 * `npm test 2>&1 | tail -30`, are the same check, so a
 * later pass of any of them clears the same issue.
 */
function coreCommand(summary) {
    let s = summary.replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\d?>&\d/g, '').replace(/\s*\d?>\s*\/dev\/null/g, '');
    s = s.replace(/\s*\|\s*(tail|head|grep|cat|less|tee|sed|awk|wc)\b.*$/, '');
    return s.trim();
}
/** Command/test identity: which later pass can clear the issue. */
export function commandKey(call) {
    return `${call.tool}:${call.runner ?? coreCommand(call.summary)}`;
}
/** Strip volatile content (numbers, paths, timestamps, ANSI) so the same error fingerprints identically. */
export function normalizeError(text) {
    let s = ` ${text} `.replace(/\x1b\[[\d;]*m/g, ' ').toLowerCase();
    s = s.replace(/\S*[\\/]\S*/g, ' <path> ');
    s = s.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?/g, ' ');
    s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(z|utc|am|pm|[+-]\d{2}:?\d{2})?\b/g, ' ');
    s = s.replace(/\b\d+(\.\d+)?\b/g, ' ');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
/**
 * Identities are hashed: router snapshots are journaled to disk, and commands
 * or tool output can contain file contents or secrets.
 */
export function identity(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 20);
}
/** Stable failure fingerprint: the command/test plus its normalized error text. */
export function fingerprint(call) {
    return `${commandKey(call)}|${normalizeError(call.result)}`;
}
/**
 * Failures that reflect missing infrastructure, not reasoning problems:
 * network/registry unreachability, permissions, credentials, missing commands.
 * Matching is intentionally conservative — a genuine code or test bug must
 * never be reclassified as an environment blocker.
 */
const ENVIRONMENT_PATTERNS = [
    /\bE(NOTFOUND|CONNREFUSED|CONNRESET|CONNABORTED|TIMEDOUT|SOCKETTIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b/i,
    /\b(fetch failed|socket hang up|network error|could not resolve host|temporary failure in name resolution|getaddrinfo|dns (lookup|resolution)|no route to host|connection (refused|reset|timed out)|request timed out|network timeout)\b/i,
    /\b(EACCES|EPERM)\b|permission denied|operation not permitted|access (is )?denied/i,
    /command not found|is not recognized as|no such command/i,
    /\b(401|403)\b.{0,40}(unauthorized|forbidden|authentication|denied)|invalid (api[ _-]?key|access token|credentials?)|bad credentials|authentication (failed|error)|credentials? (not found|missing|invalid|expired|revoked)|unauthorized (access|client)/i,
    /\bnpm (err|error)!?\s*(code\s+)?(econnrefused|enotfound|etimedout|eai_again|network)|registry[^\n]{0,60}(unreachable|timed out|error|unable)|temporary failure resolving/i,
    /\b(rate limit(ed)?|too many requests|service unavailable|bad gateway|gateway time-?out|upstream (error|unavailable))\b/i,
];
const LOOKUP_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);
const LOOKUP_COMMANDS = new Set(['ls', 'cat', 'find', 'grep', 'rg', 'head', 'tail', 'stat', 'file', 'which', 'type', 'test', '[', 'pwd', 'echo', 'wc', 'tree', 'eza', 'bat', 'less', 'more', 'du', 'df', 'readlink', 'realpath', 'basename', 'dirname', 'printf', 'true', 'command', 'cd']);
/**
 * A failed call that only looked something up: a lookup tool, or a shell
 * command whose every segment is a read-only lookup. A command with a test or
 * build runner is never exploratory, so check failures always count.
 */
export function isExploratoryFailure(call) {
    if (call.runner)
        return false;
    if (LOOKUP_TOOLS.has(call.tool))
        return true;
    if (call.tool !== 'Bash')
        return false;
    const segments = call.summary.replace(/…$/, '').split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
    return segments.length > 0 && segments.every((seg) => LOOKUP_COMMANDS.has(seg.split(/\s+/)[0].replace(/^command$/, 'command')));
}
export function isEnvironmentFailure(call) {
    const text = `${call.result}\n${call.summary}`;
    return ENVIRONMENT_PATTERNS.some((re) => re.test(text));
}
/** Issues that reflect reasoning problems, not environment blockers. */
export function reasoningIssues(state) {
    return state.issues.filter((i) => !i.environment);
}
/**
 * Fold one tool batch into the state. A successful call only clears issues
 * whose command/test key matches; unrelated successes leave issues open.
 */
export function reduceBatch(state, batch, effort) {
    const issues = state.issues.map((i) => ({ ...i, tried: [...i.tried] }));
    const clock = state.clock + 1;
    const outcome = {
        newIssues: [], repeated: [], resolved: [],
        failedCalls: 0, exploratoryFailures: 0, environmentFailures: 0, environmentOnly: false, progress: 'steady',
    };
    const cleared = new Set();
    for (const call of batch) {
        const readable = commandKey(call);
        const command = identity(readable);
        // Looking around (a glob with no matches, a missing file) is not a
        // correctness failure: it neither escalates nor lingers as an open issue.
        if (call.failed && isExploratoryFailure(call)) {
            outcome.exploratoryFailures++;
            continue;
        }
        if (call.failed) {
            outcome.failedCalls++;
            const environment = isEnvironmentFailure(call);
            if (environment)
                outcome.environmentFailures++;
            const fp = identity(fingerprint(call));
            let issue = issues.find((i) => i.fingerprint === fp && !cleared.has(i));
            if (issue) {
                issue.attempts++;
                issue.lastSeen = clock;
                if (!issue.tried.includes(effort))
                    issue.tried.push(effort);
                if (!outcome.repeated.includes(issue))
                    outcome.repeated.push(issue);
            }
            else {
                issue = {
                    fingerprint: fp, command, label: readable.slice(0, 80), environment, attempts: 1, tried: [effort], lastSeen: clock,
                    ...(call.runner ? { runner: identity(`runner:${call.runner}`) } : {}),
                };
                issues.push(issue);
                outcome.newIssues.push(issue);
            }
        }
        else {
            const runner = call.runner ? identity(`runner:${call.runner}`) : undefined;
            for (const i of issues) {
                if ((runner !== undefined ? i.runner === runner : i.command === command && !call.summary.endsWith('…')) && !cleared.has(i)) {
                    cleared.add(i);
                    outcome.resolved.push(i);
                }
            }
        }
    }
    outcome.environmentOnly = outcome.failedCalls > 0 && outcome.environmentFailures === outcome.failedCalls;
    outcome.progress = outcome.newIssues.length ? 'new-failure'
        : outcome.repeated.length ? 'repeat-failure'
            : outcome.resolved.length ? 'resolved' : 'steady';
    return { state: { clock, issues: issues.filter((i) => !cleared.has(i)), last: outcome }, outcome };
}
/** The serializable part of the reducer state. */
export function serializeCore(s) {
    // Drop the readable label: the snapshot is persisted and must hold hashes only.
    return { clock: s.clock, issues: s.issues.map(({ label: _label, ...rest }) => rest) };
}
/** Tolerant restore: invalid issues are dropped, a missing/garbage payload yields null. */
export function reviveCore(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const r = raw;
    const clock = typeof r.clock === 'number' && Number.isFinite(r.clock) ? Math.max(0, Math.floor(r.clock)) : 0;
    const issues = [];
    if (Array.isArray(r.issues)) {
        for (const x of r.issues) {
            const i = x;
            if (!i || typeof i !== 'object' || typeof i.fingerprint !== 'string' || typeof i.command !== 'string')
                continue;
            issues.push({
                fingerprint: i.fingerprint,
                command: i.command,
                environment: i.environment === true,
                attempts: typeof i.attempts === 'number' && Number.isFinite(i.attempts) ? Math.max(1, Math.floor(i.attempts)) : 1,
                tried: Array.isArray(i.tried) ? i.tried.filter(isEffort) : [],
                lastSeen: typeof i.lastSeen === 'number' && Number.isFinite(i.lastSeen) ? Math.floor(i.lastSeen) : clock,
                ...(typeof i.runner === 'string' ? { runner: i.runner } : {}),
            });
        }
    }
    return { clock, issues, last: null };
}
