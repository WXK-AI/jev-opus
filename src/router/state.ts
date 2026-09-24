import { isEffort, type Effort } from '../effort.ts';
import type { ToolCallSummary } from './types.ts';

/**
 * Pure reducer over tool batches.
 *
 * Tracks unresolved issues by a stable failure fingerprint (normalized error
 * text plus the command/test that produced it), the effort levels already
 * tried against each issue, batch-to-batch progress, and failures that are
 * environment blockers rather than reasoning problems. No I/O, no wall clock,
 * no randomness: the whole state is JSON-serializable so an adapter can
 * snapshot it and restore the common-ancestor state after a rewind.
 */

export interface Issue {
  /** stable identity: normalized error text + command/test */
  fingerprint: string;
  /** command/test identity; a later pass with the same key clears the issue */
  command: string;
  /** failure is an environment blocker (network, permissions, missing infra…) */
  environment: boolean;
  /** batches in which this fingerprint has been observed failing */
  attempts: number;
  /** effort levels in force when this issue was observed failing */
  tried: Effort[];
  /** batch index when this issue was last observed */
  lastSeen: number;
}

export interface BatchOutcome {
  /** issues first observed failing in this batch */
  newIssues: Issue[];
  /** previously-open issues that failed again in this batch */
  repeated: Issue[];
  /** issues cleared because their command/test passed in this batch */
  resolved: Issue[];
  /** tool calls that failed in this batch, environment or not */
  failedCalls: number;
  /** failed calls classified as environment blockers */
  environmentFailures: number;
  /** every failure in this batch was an environment blocker */
  environmentOnly: boolean;
  /** how the latest batch changed outcomes */
  progress: 'new-failure' | 'repeat-failure' | 'resolved' | 'steady';
}

export interface CoreState {
  /** batches reduced so far */
  clock: number;
  issues: Issue[];
  /** outcome of the most recent batch (transient; not serialized) */
  last: BatchOutcome | null;
}

export function emptyCore(): CoreState {
  return { clock: 0, issues: [], last: null };
}

/**
 * Output plumbing that doesn't change what a command runs: `npm test`,
 * `npm test 2>&1 | tail -30`, and `cd app && npm test` are the same check, so a
 * later pass of any of them clears the same issue.
 */
function coreCommand(summary: string): string {
  let s = summary.replace(/\s+/g, ' ').trim().toLowerCase();
  s = s.replace(/^(cd \S+ (&&|;) )+/, '');
  s = s.replace(/\s*\d?>&\d/g, '').replace(/\s*\d?>\s*\/dev\/null/g, '');
  s = s.replace(/\s*\|\s*(tail|head|grep|cat|less|tee|sed|awk|wc)\b.*$/, '');
  return s.trim();
}

/** Command/test identity: which later pass can clear the issue. */
export function commandKey(call: ToolCallSummary): string {
  return `${call.tool}:${coreCommand(call.summary).slice(0, 160)}`;
}

/** Strip volatile content (numbers, paths, timestamps, ANSI) so the same error fingerprints identically. */
export function normalizeError(text: string): string {
  let s = ` ${text} `.replace(/\x1b\[[\d;]*m/g, ' ').toLowerCase();
  s = s.replace(/\S*[\\/]\S*/g, ' <path> ');
  s = s.replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?/g, ' ');
  s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(z|utc|am|pm|[+-]\d{2}:?\d{2})?\b/g, ' ');
  s = s.replace(/\b\d+(\.\d+)?\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Stable failure fingerprint: the command/test plus its normalized error text. */
export function fingerprint(call: ToolCallSummary): string {
  return `${commandKey(call)}|${normalizeError(call.result)}`;
}

/**
 * Failures that reflect missing infrastructure, not reasoning problems:
 * network/registry unreachability, permissions, credentials, missing commands.
 * Matching is intentionally conservative — a genuine code or test bug must
 * never be reclassified as an environment blocker.
 */
const ENVIRONMENT_PATTERNS: readonly RegExp[] = [
  /\bE(NOTFOUND|CONNREFUSED|CONNRESET|CONNABORTED|TIMEDOUT|SOCKETTIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b/i,
  /\b(fetch failed|socket hang up|network error|could not resolve host|temporary failure in name resolution|getaddrinfo|dns (lookup|resolution)|no route to host|connection (refused|reset|timed out)|request timed out|network timeout)\b/i,
  /\b(EACCES|EPERM)\b|permission denied|operation not permitted|access (is )?denied/i,
  /command not found|is not recognized as|no such command/i,
  /\b(401|403)\b.{0,40}(unauthorized|forbidden|authentication|denied)|invalid (api[ _-]?key|access token|credentials?)|bad credentials|authentication (failed|error)|credentials? (not found|missing|invalid|expired|revoked)|unauthorized (access|client)/i,
  /\bnpm (err|error)!?\s*(code\s+)?(econnrefused|enotfound|etimedout|eai_again|network)|registry[^\n]{0,60}(unreachable|timed out|error|unable)|temporary failure resolving/i,
  /\b(rate limit(ed)?|too many requests|service unavailable|bad gateway|gateway time-?out|upstream (error|unavailable))\b/i,
];

export function isEnvironmentFailure(call: ToolCallSummary): boolean {
  const text = `${call.result}\n${call.summary}`;
  return ENVIRONMENT_PATTERNS.some((re) => re.test(text));
}

/** Issues that reflect reasoning problems, not environment blockers. */
export function reasoningIssues(state: CoreState): Issue[] {
  return state.issues.filter((i) => !i.environment);
}

/**
 * Fold one tool batch into the state. A successful call only clears issues
 * whose command/test key matches; unrelated successes leave issues open.
 */
export function reduceBatch(
  state: CoreState,
  batch: readonly ToolCallSummary[],
  effort: Effort,
): { state: CoreState; outcome: BatchOutcome } {
  const issues = state.issues.map((i) => ({ ...i, tried: [...i.tried] }));
  const clock = state.clock + 1;
  const outcome: BatchOutcome = {
    newIssues: [], repeated: [], resolved: [],
    failedCalls: 0, environmentFailures: 0, environmentOnly: false, progress: 'steady',
  };
  const cleared = new Set<Issue>();

  for (const call of batch) {
    const command = commandKey(call);
    if (call.failed) {
      outcome.failedCalls++;
      const environment = isEnvironmentFailure(call);
      if (environment) outcome.environmentFailures++;
      const fp = fingerprint(call);
      let issue = issues.find((i) => i.fingerprint === fp && !cleared.has(i));
      if (issue) {
        issue.attempts++;
        issue.lastSeen = clock;
        if (!issue.tried.includes(effort)) issue.tried.push(effort);
        if (!outcome.repeated.includes(issue)) outcome.repeated.push(issue);
      } else {
        issue = { fingerprint: fp, command, environment, attempts: 1, tried: [effort], lastSeen: clock };
        issues.push(issue);
        outcome.newIssues.push(issue);
      }
    } else {
      for (const i of issues) {
        if (i.command === command && !cleared.has(i)) {
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
export function serializeCore(s: CoreState): { clock: number; issues: Issue[] } {
  return { clock: s.clock, issues: s.issues };
}

/** Tolerant restore: invalid issues are dropped, a missing/garbage payload yields null. */
export function reviveCore(raw: unknown): CoreState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { clock?: unknown; issues?: unknown };
  const clock = typeof r.clock === 'number' && Number.isFinite(r.clock) ? Math.max(0, Math.floor(r.clock)) : 0;
  const issues: Issue[] = [];
  if (Array.isArray(r.issues)) {
    for (const x of r.issues) {
      const i = x as Partial<Issue> | null;
      if (!i || typeof i !== 'object' || typeof i.fingerprint !== 'string' || typeof i.command !== 'string') continue;
      issues.push({
        fingerprint: i.fingerprint,
        command: i.command,
        environment: i.environment === true,
        attempts: typeof i.attempts === 'number' && Number.isFinite(i.attempts) ? Math.max(1, Math.floor(i.attempts)) : 1,
        tried: Array.isArray(i.tried) ? i.tried.filter(isEffort) : [],
        lastSeen: typeof i.lastSeen === 'number' && Number.isFinite(i.lastSeen) ? Math.floor(i.lastSeen) : clock,
      });
    }
  }
  return { clock, issues, last: null };
}
