/** One-line renderings of Claude Code tool inputs/results for the UI and for Jev's state. */

import { ENVIRONMENT_PATTERNS } from '../router/state.ts';
import type { CommandKind, FailureCause, ToolCallSummary } from '../router/types.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function describeToolInput(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (tool) {
    case 'Bash': return clip(str('command').replace(/\s+/g, ' '), 160);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return str('file_path') || str('notebook_path');
    case 'Grep': return `"${clip(str('pattern'), 80)}"${str('path') ? ` in ${str('path')}` : ''}`;
    case 'Glob': return str('pattern');
    case 'WebFetch': return str('url');
    case 'WebSearch': return str('query');
    case 'Task': case 'Agent': return str('description') || clip(str('prompt'), 100);
    default: {
      const json = JSON.stringify(input ?? {});
      return clip(json === '{}' ? '' : json, 120);
    }
  }
}

export function stringifyResult(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n');
  }
  const r = response as Record<string, unknown>;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    return [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n');
  }
  return JSON.stringify(response);
}

// ── Failure classification ────────────────────────────────────────────────
//
// A tool result is failure evidence only when it can be attributed to a check
// that just ran. Structured errors (non-zero exit, hook failure, interrupt)
// always count. Output text counts only for commands that run a recognized
// check, where it can reveal a failure a pipeline masked (`npm test | tail`).
// Attribution rules, since one output mixes every command's text:
// - a check's zero-failure summary (`# fail 0`) is the verdict of one check
//   only: it clears other failure text only when the command runs one check
//   and the output shows nothing else ran — no script started after the
//   summary (a `posttest` hook) and no script runner reported failing;
// - when the command also prints stored content (a file, a diff), failure
//   markers cannot be told apart from what was read: they are suspect. A
//   failing summary line (`# fail 2`, `FAILED (failures=1)`) is a runner's
//   format that source files don't contain, so it still counts — unless the
//   command also reads logs or saved output, which can hold old summaries;
// - a passing summary beside only weak markers (a traceback, `Error:`) from
//   another check is conflicting evidence: suspect.
// Suspect evidence is shown to the evaluator but never opens or clears a
// durable unresolved issue. Reading source, diffs, or old logs never fails.

/** Largest slice of output scanned for a verdict: the head plus the tail, where summaries live. */
const SCAN_CHARS = 200_000;
const EVIDENCE_LINES = 4;

export interface ToolOutcome {
  failed: boolean;
  suspect: boolean;
  cause?: FailureCause;
  kind?: CommandKind;
  /** marker lines when failed/suspect (the same text later fingerprinted), else the head of the output */
  evidence: string;
}

/**
 * Classify one tool result. `text` is the rendered result, `isError` the
 * tool's own error flag, `response` an optional structured response (Agent
 * SDK hooks) that may carry exit status or an interrupt flag.
 */
export function classifyToolResult(tool: string, input: unknown, text: string, isError: boolean, response?: unknown): ToolOutcome {
  const shape = tool === 'Bash' ? analyzeCommand(String(((input ?? {}) as Record<string, unknown>).command ?? '')) : undefined;
  const kind = shape?.kind;
  const structured = structuredFailure(response);
  if (isError || structured) {
    const scan = scanOutput(text);
    const lines = [...scan.failures, ...scan.markers, ...scan.environment];
    return { failed: true, suspect: false, cause: structured === 'interrupted' ? 'interrupted' : 'tool-error', kind, evidence: lines.length ? evidenceText(lines) : clip(text, 600) };
  }
  const passed: ToolOutcome = { failed: false, suspect: false, kind, evidence: clip(text, 600) };
  if (kind !== 'check' && kind !== 'other') return passed;
  const scan = scanOutput(text);
  const lines = [...scan.failures, ...scan.markers];
  if (!lines.length) return passed;
  const passingSummary = scan.summaries && !scan.failures.length;
  const suspect: ToolOutcome = { failed: false, suspect: true, cause: 'output-text', kind, evidence: evidenceText(lines) };
  if (kind === 'other') return passingSummary ? passed : suspect;
  // The only check's own passing summary outranks failure words elsewhere,
  // unless the output shows the command ran more than that check.
  if (passingSummary && shape!.checks === 1 && !scan.uncovered) return passed;
  if (shape!.readsContent && (shape!.readsLogs || !scan.failures.length)) return suspect;
  if (passingSummary && scan.strong === 0) return suspect;
  return { failed: true, suspect: false, cause: scan.failures.length ? 'check-summary' : 'check-output', kind, evidence: evidenceText(lines) };
}

/** The router's view of one tool call. */
export function summarizeToolCall(tool: string, input: unknown, text: string, isError: boolean, id?: string, response?: unknown): ToolCallSummary {
  const o = classifyToolResult(tool, input, text, isError, response);
  return {
    tool,
    summary: describeToolInput(tool, input),
    runner: testRunner(tool, input),
    failed: o.failed,
    result: o.evidence,
    ...(id ? { id } : {}),
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.cause ? { cause: o.cause } : {}),
    ...(o.suspect ? { suspect: true } : {}),
  };
}

function structuredFailure(response: unknown): 'error' | 'interrupted' | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const r = response as Record<string, unknown>;
  if (r.interrupted === true) return 'interrupted';
  if (r.is_error === true || r.success === false) return 'error';
  for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) {
    if (typeof r[k] === 'number' && r[k] !== 0) return 'error';
  }
  return undefined;
}

function evidenceText(lines: readonly string[]): string {
  return [...new Set(lines.map((l) => clip(l.trim(), 160)))].slice(0, EVIDENCE_LINES).join('\n');
}

// Check summaries: [pattern, failures(match)]. A match marks the output as
// carrying a verdict; a positive failure count makes it a failing one.
const SUMMARIES: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => number]> = [
  // TAP / node:test (`# fail 0`, `ℹ fail 0`)
  [/^\s*[#ℹ]\s*fail\s+(\d+)\s*$/, (m) => Number(m[1])],
  // jest / vitest (`Tests: 1 failed, 2 passed, 3 total`, `Tests  1 failed | 2 passed (3)`)
  [/^\s*Tests?(?:\s+Files|\s+Suites)?:?\s+(?=.*\b\d+\s+(?:passed|failed|total)\b)(.*)$/, (m) => count(m[1]!, /(\d+)\s+failed/)],
  // pytest (`=== 2 failed, 70 passed in 0.26s ===`, `70 passed in 0.1s`)
  [/^=*\s*((?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|warnings?|deselected|rerun)(?:,\s*)?)+) in [\d.]+s\b/, (m) => count(m[1]!, /(\d+) failed/) + count(m[1]!, /(\d+) errors?/)],
  // cargo
  [/^test result: (?:ok|FAILED)\. \d+ passed; (\d+) failed/, (m) => Number(m[1])],
  // mocha
  [/^\s*\d+ passing\b/, () => 0],
  [/^\s*(\d+) failing\b/, (m) => Number(m[1])],
  // rspec / minitest
  [/^\d+ (?:examples?|runs?|tests?), (?:\d+ assertions, )?(\d+) failures?(?:, (\d+) errors?)?/, (m) => Number(m[1]) + Number(m[2] ?? 0)],
  // unittest
  [/^Ran \d+ tests? in /, () => 0],
  [/^FAILED \((?:failures|errors)=(\d+)(?:, (?:failures|errors)=(\d+))?/, (m) => Number(m[1]) + Number(m[2] ?? 0)],
  // go
  [/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/, () => 0],
  [/^FAIL(?:\s+\S+\s+[\d.]+s|\s*$)/, () => 1],
  // tsc
  [/^Found (\d+) errors?\b/, (m) => Number(m[1])],
];

// Failure markers, anchored to the start of a line so quoted source, grep
// hits (`file:12:…`), and diff lines (`+…`) don't match. Strong markers are
// verdict lines a runner prints only for a failure; weak ones (a traceback,
// an `Error:` line, an assertion diff) also appear in logs of passing runs.
const WEAK_MARKERS: readonly RegExp[] = [
  /^Traceback \(most recent call last\)/,
  /^\s*(?:[A-Z]\w*)?Error(?: \[[A-Z_]+\])?: /,
  /^\s*\+ actual - expected\b/,
];
/**
 * Lines a script runner or the shell prints when the command around a check
 * fails (a hook, a later step of the script): no check summary covers them.
 */
const RUNNER_FAILURES: readonly RegExp[] = [
  /^npm (?:ERR!|error) |^ERR_PNPM_|^\s*ELIFECYCLE\b/,
  /^error Command failed with exit code \d+|^error: script ".*" exited with code \d+/,
  /^make(?:\[\d+\])?: \*\*\* /,
  /^(?:\S*sh: )?(?:line \d+: )?[\w./-]+: command not found\s*$|^\S*sh: command not found: /,
  /^Exit code [1-9]\d*/,
];
const STRONG_MARKERS: readonly RegExp[] = [
  ...RUNNER_FAILURES,
  /^\s*not ok \d+/,
  /^\s*(?:FAIL|FAILED|ERROR)(?::|\s|$)(?!\s*[:=]?\s*0\b)/,
  /^\s*--- FAIL\b/,
  /^\s*[✖✗✘×]\s/,
  /^thread '.*' panicked at\b|^panic: /,
  /^error(?:\[E\d+\])?: /,
  /(?:^|\s)error TS\d+: /,
  // `git diff --check`
  /^\S.*:\d+: (?:(?:trailing whitespace|space before tab in indent|indent with non-tab characters|tab in indent)(?:, [a-z -]+)*\.|new blank line at EOF\.|leftover conflict marker)$/,
];
/** A script runner starting a script: npm/pnpm's `> pkg@1.0.0 posttest`, yarn/bun's `$ node validate.js`. */
const SCRIPT_START = /^> \S+ \S|^\$ \S/;

function count(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? Number(m[1]) : 0;
}

interface Scan {
  /** a check summary was found */
  summaries: boolean;
  /** summary lines reporting a positive failure count */
  failures: string[];
  /** marker lines */
  markers: string[];
  /** how many marker lines matched a strong marker */
  strong: number;
  /** lines naming an environment blocker (kept as evidence for classification) */
  environment: string[];
  /** the output shows more ran than the check behind the last summary: a script started after it, or a runner reported failing */
  uncovered: boolean;
}

export function scanOutput(text: string): Scan {
  const sample = text.length <= SCAN_CHARS ? text : `${text.slice(0, SCAN_CHARS / 2)}\n${text.slice(-SCAN_CHARS / 2)}`;
  const scan: Scan = { summaries: false, failures: [], markers: [], strong: 0, environment: [], uncovered: false };
  let scriptAfterSummary = false, runnerFailed = false;
  for (const raw of sample.split('\n')) {
    const line = raw.replace(/\x1b\[[\d;]*m/g, '').trimEnd();
    if (!line) continue;
    let summary = false;
    for (const [re, failures] of SUMMARIES) {
      const m = line.match(re);
      if (!m) continue;
      summary = true;
      scan.summaries = true;
      if (failures(m) > 0 && scan.failures.length < EVIDENCE_LINES) scan.failures.push(line);
      break;
    }
    if (summary) scriptAfterSummary = false;
    else {
      if (scan.summaries && SCRIPT_START.test(line)) scriptAfterSummary = true;
      if (RUNNER_FAILURES.some((re) => re.test(line))) runnerFailed = true;
      const strong = STRONG_MARKERS.some((re) => re.test(line));
      if (strong) scan.strong++;
      if ((strong || WEAK_MARKERS.some((re) => re.test(line))) && scan.markers.length < EVIDENCE_LINES) scan.markers.push(line);
    }
    if (scan.environment.length < EVIDENCE_LINES && ENVIRONMENT_PATTERNS.some((re) => re.test(line))) scan.environment.push(line);
  }
  scan.uncovered = scriptAfterSummary || runnerFailed;
  return scan;
}

// ── Shell command classification ──────────────────────────────────────────

/** A pipeline of simple commands; `captured` when its output is substituted (`$(…)`, backticks, `<(…)`), not printed. */
interface Pipeline {
  stages: string[];
  captured: boolean;
}

/**
 * Pipelines of a shell script, including those inside `$(…)`, backticks, and
 * process substitution, with comments and non-shell heredoc bodies removed
 * (a heredoc fed to a shell is kept: it runs). An approximation for
 * classification, not a shell parser: quoting is respected, and redirections
 * such as `2>&1` stay attached to their command.
 */
function parsePipelines(command: string): Pipeline[] {
  const src = stripHeredocs(command);
  const out: Pipeline[] = [];
  type Frame = { seg: string; stages: string[]; quote: '' | '"' | "'" | "$'"; close: '' | ')' | '`' };
  const stack: Frame[] = [{ seg: '', stages: [], quote: '', close: '' }];
  const stage = (f: Frame) => { if (f.seg.trim()) f.stages.push(f.seg.trim()); f.seg = ''; };
  const end = (f: Frame) => { stage(f); if (f.stages.length) out.push({ stages: f.stages, captured: f.close !== '' }); f.stages = []; };
  const open = (close: ')' | '`') => stack.push({ seg: '', stages: [], quote: '', close });
  for (let i = 0; i < src.length; i++) {
    const f = stack[stack.length - 1]!;
    const c = src[i]!;
    if (f.quote === "'") { f.seg += c; if (c === "'") f.quote = ''; continue; }
    if (c === '\\') { f.seg += c + (src[i + 1] ?? ''); i++; continue; }
    if (f.quote === "$'") { f.seg += c; if (c === "'") f.quote = ''; continue; }
    if (c === '$' && src[i + 1] === "'" && !f.quote) { f.quote = "$'"; f.seg += "$'"; i++; continue; }
    if (c === '$' && src.startsWith('((', i + 1)) {
      const close = src.indexOf('))', i + 3);
      const stop = close < 0 ? src.length : close + 2;
      f.seg += src.slice(i, stop); i = stop - 1; continue;
    }
    if ((c === '$' || (!f.quote && (c === '<' || c === '>'))) && src[i + 1] === '(') { f.seg += '$()'; open(')'); i++; continue; }
    if (c === '`') {
      if (f.close === '`' && !f.quote) { end(f); stack.pop(); continue; }
      f.seg += '``'; open('`'); continue;
    }
    if (f.quote === '"') { f.seg += c; if (c === '"') f.quote = ''; continue; }
    if (c === "'" || c === '"') { f.quote = c; f.seg += c; continue; }
    if (c === ')' && f.close === ')') { end(f); stack.pop(); continue; }
    if (c === '#' && /(^|\s)$/.test(f.seg)) { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue; }
    // Redirections (`2>&1`, `&>file`, `>&2`) are part of the command, not separators.
    if (c === '&' && (/[<>]$/.test(f.seg) || src[i + 1] === '>')) { f.seg += c; continue; }
    if (c === '|' && src[i + 1] !== '|') { stage(f); if (src[i + 1] === '&') i++; continue; }
    if (c === '|' || c === '&') { end(f); if (src[i + 1] === c) i++; continue; }
    if (c === ';' || c === '\n' || c === '(' || c === ')') { end(f); continue; }
    f.seg += c;
  }
  while (stack.length) end(stack.pop()!);
  return out;
}

/** Simple commands of a shell script (see parsePipelines). */
export function shellSegments(command: string): string[] {
  return parsePipelines(command).flatMap((p) => p.stages);
}

/** A heredoc redirection (`<<EOF`, `<<-'EOF'`) at `[start, end)` of its line, with the body it reads. */
interface Heredoc {
  start: number;
  end: number;
  delimiter: string;
  /** `<<-`: leading tabs are stripped from body lines and the delimiter line */
  stripTabs: boolean;
  body: string[];
}

/** Shell quoting context: code (top level, `$(…)`, backticks), quotes, and arithmetic (`close` is `)` for `$((`). */
type QuoteFrame = { kind: 'code' | "'" | "$'" | '"' | 'arith'; close: '' | ')' | '`'; depth: number };

/**
 * Heredoc operators on one line of a script, outside quotes, comments,
 * here-strings (`<<<`), and arithmetic (`$((1<<2))`). `stack` is the quoting
 * context the line starts in and is left where the line ends, so a quote or
 * `$(…)` left open carries into the next line. `continues` when a quote stays
 * open or the line ends in a backslash: the command line, and so the point
 * where heredoc bodies begin, extends past this line.
 */
function heredocOperators(line: string, stack: QuoteFrame[]): { ops: Heredoc[]; continues: boolean } {
  const ops: Heredoc[] = [];
  let escapedNewline = false;
  for (let i = 0; i < line.length; i++) {
    const f = stack[stack.length - 1]!;
    const c = line[i]!;
    if (f.kind === "'") { if (c === "'") stack.pop(); continue; }
    if (f.kind === "$'") { if (c === '\\') i++; else if (c === "'") stack.pop(); continue; }
    if (c === '\\') { if (i === line.length - 1) escapedNewline = true; i++; continue; }
    if (c === '$' && line[i + 1] === '(') {
      if (line[i + 2] === '(') { stack.push({ kind: 'arith', close: ')', depth: 0 }); i += 2; }
      else { stack.push({ kind: 'code', close: ')', depth: 0 }); i++; }
      continue;
    }
    if (c === '`') {
      if (f.kind === 'code' && f.close === '`') stack.pop();
      else stack.push({ kind: 'code', close: '`', depth: 0 });
      continue;
    }
    if (f.kind === '"') { if (c === '"') stack.pop(); continue; }
    if (f.kind === 'arith') {
      if (c === '(') f.depth++;
      else if (c === ')' && f.depth) f.depth--;
      else if (c === ')' && line[i + 1] === ')') { stack.pop(); i++; }
      else if (c === ')') {
        // Not arithmetic after all: `((cd a) | x)` and `$((cd a) | x)` are nested subshells.
        stack.pop();
        if (f.close === ')') stack.push({ kind: 'code', close: ')', depth: 0 });
        else stack[stack.length - 1]!.depth++;
      }
      continue;
    }
    const wordStart = i === 0 || /[\s;&|()]/.test(line[i - 1]!);
    if (c === '$' && line[i + 1] === "'") { stack.push({ kind: "$'", close: '', depth: 0 }); i++; continue; }
    if (c === "'" || c === '"') { stack.push({ kind: c, close: '', depth: 0 }); continue; }
    if (c === '(' && line[i + 1] === '(' && wordStart) { stack.push({ kind: 'arith', close: '', depth: 0 }); i++; continue; }
    if (c === '(') { f.depth++; continue; }
    if (c === ')') { if (f.close === ')') { if (f.depth) f.depth--; else stack.pop(); } continue; }
    if (c === '#' && wordStart) break; // a comment: the rest of the line
    if (c !== '<' || line[i + 1] !== '<') continue;
    if (line[i + 2] === '<') { i += 2; continue; } // here-string
    let j = i + 2;
    const stripTabs = line[j] === '-';
    if (stripTabs) j++;
    while (line[j] === ' ' || line[j] === '\t') j++;
    let delimiter = '', any = false;
    for (; j < line.length && !/[\s;&|<>()]/.test(line[j]!); j++) {
      const d = line[j]!;
      any = true;
      if (d === "'" || d === '"') {
        const close = line.indexOf(d, j + 1);
        const stop = close < 0 ? line.length : close;
        delimiter += line.slice(j + 1, stop); j = stop;
      } else if (d === '\\') { delimiter += line[j + 1] ?? ''; j++; }
      else delimiter += d;
    }
    if (!any) { i++; continue; }
    // A file descriptor (`0<<EOF`) belongs to the operator.
    let start = i;
    while (start > 0 && /\d/.test(line[start - 1]!)) start--;
    if (start > 0 && !/[\s;&|()]/.test(line[start - 1]!)) start = i;
    ops.push({ start, end: j, delimiter, stripTabs, body: [] });
    i = j - 1;
  }
  const top = stack[stack.length - 1]!.kind;
  return { ops, continues: escapedNewline || top === "'" || top === "$'" || top === '"' };
}

/**
 * Lines of a script with each heredoc's body attached to the operator that
 * reads it. Bodies are removed from the lines; `unterminated` when a body
 * runs to the end of the script.
 */
function heredocLines(command: string): { lines: Array<{ text: string; heredocs: Heredoc[] }>; unterminated: boolean } {
  const src = command.split('\n');
  const lines: Array<{ text: string; heredocs: Heredoc[] }> = [];
  const stack: QuoteFrame[] = [{ kind: 'code', close: '', depth: 0 }];
  let pending: Heredoc[] = [];
  let unterminated = false;
  for (let n = 0; n < src.length; n++) {
    const { ops, continues } = heredocOperators(src[n]!, stack);
    lines.push({ text: src[n]!, heredocs: ops });
    pending.push(...ops);
    if (continues) continue;
    // Bodies follow the end of the command line, one after another.
    for (const h of pending) {
      let closed = false;
      while (++n < src.length) {
        const body = h.stripTabs ? src[n]!.replace(/^\t+/, '') : src[n]!;
        if (body === h.delimiter) { closed = true; break; }
        h.body.push(body);
      }
      if (!closed) unterminated = true;
    }
    pending = [];
  }
  return { lines, unterminated };
}

/**
 * Drop heredoc bodies (file contents, Python scripts…), except a body fed to
 * a shell, which runs: it is kept as a `{ … }` group so a pipeline after the
 * heredoc (`bash <<EOF | tail`) still reads the group's output.
 */
function stripHeredocs(command: string): string {
  const kept: string[] = [];
  for (const { text, heredocs } of heredocLines(command).lines) {
    // The line without its operators; the first heredoc fed to a shell splits it around the body.
    let line = '', from = 0;
    let shell: { head: string; body: string[] } | undefined;
    for (const h of heredocs) {
      line += text.slice(from, h.start);
      from = h.end;
      if (shell) { line += ' '; continue; }
      const start = line.search(/[^;&|(]*$/);
      const owner = words(line.slice(start)).filter((w) => !/^\d*[<>]/.test(w));
      const inv = shellInvocation(owner.slice(1));
      if (owner.length > 0 && SHELLS.has(base(owner[0]!)) && inv.command === undefined && inv.script === undefined) {
        shell = { head: `${line.slice(0, start)} {`, body: h.body };
        line = '';
      } else line += ' ';
    }
    line += text.slice(from);
    if (shell) kept.push(shell.head, stripHeredocs(shell.body.join('\n')), `} ${line}`);
    else kept.push(line);
  }
  return kept.join('\n');
}

/** The `-c` command string or script operand of a shell invocation (`bash -lc '…'`, `bash -euo pipefail -c '…'`). */
function shellInvocation(args: readonly string[]): { command?: string; script?: string } {
  let dashC = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (x === '--') { const op = args[i + 1]; return op === undefined ? {} : dashC ? { command: op } : { script: op }; }
    if (x === '--rcfile' || x === '--init-file') { i++; continue; }
    if (x.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(x)) {
      if (x[0] === '-' && x.includes('c')) dashC = true;
      if (/[oO]$/.test(x)) i++; // -o/-O take an option name
      continue;
    }
    return dashC ? { command: x } : { script: x };
  }
  return {};
}

/** Words of one simple command, with surrounding quotes removed. */
function words(segment: string): string[] {
  const out: string[] = [];
  let word = '', quote = '', any = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; any = true; continue; }
    if (c === '\\') { word += segment[i + 1] ?? ''; i++; any = true; continue; }
    if (/\s/.test(c)) { if (word || any) out.push(word); word = ''; any = false; continue; }
    word += c; any = true;
  }
  if (word || any) out.push(word);
  return out;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done', 'esac', 'in', 'coproc']);
const WRAPPERS = new Set(['sudo', 'nohup', 'nice', 'command', 'builtin', 'exec', 'env', 'xargs', 'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'unbuffer', 'doas']);
/** Shell state and control flow: they neither read nor run anything that reports. */
const NEUTRAL = new Set(['for', 'case', 'select', 'function', 'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'shift', 'local', 'declare', 'typeset', 'readonly', 'true', 'false', ':', 'wait', 'trap', 'return', 'exit', 'break', 'continue', 'shopt', 'alias', 'unalias', 'ulimit', 'umask', 'hash', 'read', 'sleep', 'setopt']);
const LOOKUP = new Set([
  'ls', 'cat', 'bat', 'batcat', 'find', 'fd', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'head', 'tail', 'less', 'more', 'wc',
  'stat', 'file', 'which', 'whereis', 'type', 'test', '[', '[[', 'pwd', 'echo', 'printf', 'tree', 'eza', 'exa', 'du', 'df',
  'readlink', 'realpath', 'basename', 'dirname', 'nl', 'comm', 'sort', 'uniq', 'cut', 'tr', 'column', 'paste',
  'fold', 'rev', 'tac', 'jq', 'yq', 'xxd', 'hexdump', 'od', 'strings', 'uname', 'sw_vers', 'sysctl', 'uptime', 'whoami',
  'hostname', 'date', 'id', 'printenv', 'lsof', 'ps', 'pgrep', 'vm_stat', 'free', 'nproc', 'getconf', 'locale', 'man',
  'awk', 'gawk', 'shasum', 'sha256sum', 'sha1sum', 'md5', 'md5sum', 'cksum', 'mdfind', 'mdls', 'tokei', 'cloc', 'scc',
  'lsblk', 'history', 'fc', 'look', 'zcat', 'zgrep', 'xzcat', 'bzcat', 'expand', 'iconv', 'base64', 'sed', 'perl',
  'journalctl',
]);
/**
 * Lookups whose output is metadata (names, sizes, system facts) or text the
 * command itself authored (`echo`), not stored content such as a source file
 * or an old log that could contain failure text.
 */
const METADATA = new Set([
  'ls', 'stat', 'file', 'which', 'whereis', 'type', 'test', '[', '[[', 'pwd', 'echo', 'printf', 'tree', 'eza', 'exa', 'du', 'df',
  'readlink', 'realpath', 'basename', 'dirname', 'uname', 'sw_vers', 'sysctl', 'uptime', 'whoami', 'hostname', 'date', 'id',
  'lsof', 'ps', 'pgrep', 'vm_stat', 'free', 'nproc', 'getconf', 'locale', 'wc', 'shasum', 'sha256sum', 'sha1sum', 'md5',
  'md5sum', 'cksum', 'mdls', 'tokei', 'cloc', 'scc', 'lsblk',
]);
/** Comparisons: their exit status is a verification result, their output a display of differences. */
const COMPARE = new Set(['cmp', 'diff', 'colordiff', 'delta', 'difft']);
const QUIET = new Set([
  'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'kill', 'pkill', 'killall', 'open',
  'pbcopy', 'pbpaste', 'trash', 'rsync', 'scp', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'xz', 'curl', 'wget', 'gh', 'git', 'patch',
  'say', 'osascript', 'afplay', 'mktemp', 'truncate', 'install', 'ditto',
]);
const GIT_LOOKUP = new Set([
  'diff', 'show', 'log', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'branch', 'rev-parse', 'remote', 'config', 'reflog',
  'shortlog', 'describe', 'tag', 'cat-file', 'name-rev', 'merge-base', 'for-each-ref', 'rev-list', 'whatchanged', 'count-objects',
  'var', 'help', 'version', 'range-diff', 'annotate', 'show-ref', 'check-ignore', 'check-attr', 'difftool',
]);
const GIT_METADATA = new Set(['status', 'branch', 'rev-parse', 'remote', 'config', 'ls-files', 'ls-tree', 'describe', 'tag', 'name-rev', 'merge-base', 'for-each-ref', 'rev-list', 'count-objects', 'var', 'version', 'show-ref', 'check-ignore', 'check-attr']);
const CONTAINER_LOOKUP = new Set(['info', 'ps', 'images', 'logs', 'inspect', 'version', 'stats', 'top', 'port', 'history', 'df', 'get', 'describe', 'events', 'ls']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bun', 'deno', 'tsx', 'ts-node', 'ruby', 'bash', 'sh', 'zsh', 'dash', 'php', 'perl']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** A test/build/lint runner after launcher prefixes (`npx`, `uv run`, …) are removed. */
const CHECK_RUNNER = new RegExp([
  String.raw`^(?:npm|pnpm|yarn|bun)(?: run)? (?:\S*(?:test|check|lint|verify|typecheck|build|ci)\S*)(?:\s|$)`,
  String.raw`^(?:npm|pnpm|yarn) t(?:\s|$)`,
  String.raw`^(?:bun|deno|dotnet|swift|zig|ctest) test\b`,
  String.raw`^node (?:.* )?--test\b`,
  String.raw`^(?:vitest|jest|mocha|ava|tap|c8|nyc|playwright test|cypress run|tsc|eslint|biome (?:check|lint|ci)|prettier (?:.* )?--check|oxlint|stylelint|vue-tsc|svelte-check|astro check)\b`,
  String.raw`^(?:pytest|py\.test|tox|nox|mypy|pyright|basedpyright|ruff|flake8|pylint|black --check|isort --check)\b`,
  String.raw`^python[\d.]* -m (?:pytest|unittest|mypy|pyright|ruff|tox|nox|compileall)\b`,
  String.raw`^cargo (?:test|check|build|clippy|nextest|fmt --check|miri test)\b`,
  String.raw`^go (?:test|vet|build)\b|^golangci-lint\b|^staticcheck\b`,
  String.raw`^make(?:\s+-\S+)*(?:\s+(?:test|tests|check|lint|verify|ci|build|all)\S*)?\s*$|^make\s+(?:\S+\s+)*(?:test|tests|check|lint|verify|ci)\b`,
  String.raw`^(?:mvn|gradle|\.\/gradlew|\.\/mvnw)\b.*\b(?:test|check|build|verify)\b`,
  String.raw`^(?:rspec|rake test|rails test|phpunit|pest|mix test|dune test|stack test|cabal test|xcodebuild (?:.* )?test|shellcheck|hadolint|terraform validate|tflint|cmake --build|ninja)\b`,
].join('|'));
const LAUNCHER = /^(?:(?:uv|poetry|pipenv|pdm|hatch|rye) run|bundle exec|npx|pnpm (?:exec|dlx)|yarn (?:exec|dlx)|bunx|dotnet tool run)\s+(?:-\S+\s+)*/;
/** Project scripts named for checking: `./scripts/test.sh`, `run_tests.py`, `verify`. */
const CHECK_SCRIPT = /(?:^|[-_./])(?:tests?|checks?|verify|verification|lint|ci|typecheck)(?:[-_.]\w+)*(?:\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb))?$/i;
/** Paths that look like logs or saved command output rather than source. */
const LOG_PATH = /\.(?:log|out|output|txt|tap|jsonl|ndjson|junit|xml)$|(?:^|\/)(?:logs?|outputs?|results?|reports?|runs?|trials?|tasks)(?:\/|$)/i;
const LOG_READERS = new Set(['journalctl']);
/** Stdout sent to a file (`> out`, `>> log`, `&> all`), not to the tool result. */
const STDOUT_TO_FILE = /(?:^|\s)(?:1?>>?|&>>?)\s*(?!&)[^\s&]/;

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

interface StageInfo {
  kind: CommandKind | null;
  /** prints stored content (a file, a log, a diff) rather than output it produces */
  content: boolean;
  /** the stored content is a log or saved output, which can hold old test summaries */
  log?: boolean;
  /** a shell `-c` string, analyzed on its own */
  nested?: CommandShape;
}

function stageInfo(segment: string, depth: number): StageInfo {
  const w = words(segment);
  while (w.length) {
    const h = w[0]!;
    if (KEYWORDS.has(h) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(h) || /^\d*[<>]/.test(h)) { w.shift(); continue; }
    if (WRAPPERS.has(h)) {
      w.shift();
      while (w.length && (w[0]!.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(w[0]!) || /^[A-Za-z_]\w*=/.test(w[0]!))) w.shift();
      continue;
    }
    break;
  }
  const none: StageInfo = { kind: null, content: false };
  if (!w.length) return none;
  const name = base(w[0]!);
  if (NEUTRAL.has(name)) return none;
  const log = LOG_READERS.has(name) || w.slice(1).some((x) => LOG_PATH.test(x));
  const kind = (k: CommandKind, content = false): StageInfo => ({ kind: k, content, ...(content && log ? { log: true } : {}) });
  if (SHELLS.has(name)) {
    const inv = shellInvocation(w.slice(1));
    if (inv.command !== undefined) {
      if (depth >= 3) return kind('other');
      const nested = analyzeCommand(inv.command, depth + 1);
      return { kind: nested.kind, content: false, nested };
    }
    if (inv.script === undefined) return none; // reads its script from stdin: a heredoc body, classified on its own
  }

  const text = [name, ...w.slice(1)].join(' ').replace(LAUNCHER, '');
  if (CHECK_RUNNER.test(text)) return kind('check');
  if (CHECK_SCRIPT.test(w[0]!) && (w[0]!.includes('/') || /\.\w+$/.test(w[0]!))) return kind('check');
  if (INTERPRETERS.has(name) || /^python[\d.]+$/.test(name)) {
    const script = w.slice(1).find((x) => !x.startsWith('-'));
    if (script && !w.slice(1).some((x) => x === '-c' || x === '-e') && CHECK_SCRIPT.test(script)) return kind('check');
  }

  if (w.length === 2 && /^(?:--version|-V|-v|--help|-h|version)$/.test(w[1]!)) return kind('lookup');
  if (COMPARE.has(name)) return kind('compare', true);
  if (name === 'sed') return w.slice(1).some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place')) ? kind('quiet') : kind('lookup', true);
  if (name === 'perl') return w.slice(1).some((x) => /^-[a-zA-Z]*[ie]/.test(x)) ? kind('other') : kind('lookup', true);
  if (name === 'git') {
    let i = 1;
    while (i < w.length && w[i]!.startsWith('-')) i += /^-[Cc]$/.test(w[i]!) ? 2 : 1;
    const sub = w[i];
    const paths = w.indexOf('--', i + 1);
    const options = w.slice(i + 1, paths < 0 ? undefined : paths);
    // Validation: exits non-zero on whitespace errors and conflict markers.
    if (sub && (/^diff(?:-index|-files|-tree)?$/.test(sub) || sub === 'show' || sub === 'log') && options.includes('--check')) return kind('check');
    if (sub === 'diff' && options.some((x) => x === '--exit-code' || x === '--quiet')) return kind('compare', true);
    if (sub === 'stash' || sub === 'worktree') return w[i + 1] === 'list' ? kind('lookup') : w[i + 1] === 'show' ? kind('lookup', true) : kind('quiet');
    return sub && GIT_LOOKUP.has(sub) ? kind('lookup', !GIT_METADATA.has(sub)) : kind('quiet');
  }
  if (['docker', 'podman', 'kubectl', 'nerdctl'].includes(name)) {
    const sub = w.slice(1).filter((x) => !x.startsWith('-'));
    const verb = ['system', 'image', 'container', 'volume', 'network', 'compose'].includes(sub[0] ?? '') ? sub[1] : sub[0];
    return verb && CONTAINER_LOOKUP.has(verb) ? (verb === 'logs' ? { kind: 'lookup', content: true, log: true } : kind('lookup')) : kind('other');
  }
  if (/^python[\d.]*$/.test(name) && w[1] === '-m' && w[2] === 'json.tool') return kind('lookup', true);
  if (LOOKUP.has(name)) return kind('lookup', !METADATA.has(name));
  if (QUIET.has(name)) return kind('quiet');
  return kind('other');
}

export interface CommandShape {
  /** what the command does overall (see CommandKind) */
  kind: CommandKind;
  /** simple commands that run a check */
  checks: number;
  /** a pipeline that prints stored content (a file, a log, a diff) reaches the output */
  readsContent: boolean;
  /** some of that content is a log or saved output */
  readsLogs: boolean;
}

const KIND_ORDER: readonly CommandKind[] = ['lookup', 'quiet', 'compare', 'other', 'check'];

/**
 * What a Bash command does, judged from every simple command in it: any
 * check makes it a check; otherwise the most consequential kind wins, and it
 * is a lookup only when everything in it only reads. A pipeline's output
 * comes from its first command (`cat log | grep x` prints the log;
 * `npm test | tail` prints the test run).
 */
export function analyzeCommand(command: string, depth = 0): CommandShape {
  const shape: CommandShape = { kind: 'lookup', checks: 0, readsContent: false, readsLogs: false };
  const raise = (k: CommandKind) => { if (KIND_ORDER.indexOf(k) > KIND_ORDER.indexOf(shape.kind)) shape.kind = k; };
  for (const p of parsePipelines(command)) {
    const infos = p.stages.map((st) => stageInfo(st, depth));
    for (const info of infos) {
      if (info.nested) { shape.checks += info.nested.checks; raise(info.nested.kind); }
      else if (info.kind) { if (info.kind === 'check') shape.checks++; raise(info.kind); }
    }
    const prints = !p.captured && !STDOUT_TO_FILE.test(p.stages.at(-1)!);
    const source = infos[0]!;
    if (prints && (source.content || source.nested?.readsContent)) shape.readsContent = true;
    if (prints && (source.log || source.nested?.readsLogs)) shape.readsLogs = true;
  }
  return shape;
}

export function commandKind(command: string): CommandKind {
  return analyzeCommand(command).kind;
}

/** A conservative check identity: preserve directory, runner, flags, and test targets. */
export function testRunner(tool: string, input: unknown): string | undefined {
  if (tool !== 'Bash') return undefined;
  const i = (input ?? {}) as Record<string, unknown>;
  let command = String(i.command ?? '');
  // Ignore heredoc bodies (which can themselves contain apparent commands).
  const { lines, unterminated } = heredocLines(command);
  if (unterminated) return undefined;
  command = lines.map((l) => (l.heredocs.length ? l.text.slice(0, l.heredocs[0]!.start) : l.text)).join('\n').replace(/\s+2>&1(?=\s|$)/g, '');
  // Dynamic shell state cannot establish an equivalent suite reliably.
  if (/[$`]|\b(pushd|popd|eval|source|exec)\b/.test(command)) return undefined;
  const segments: string[] = [];
  let segment = '', quote = '', escaped = false;
  for (let n = 0; n < command.length; n++) {
    const c = command[n]!;
    if (escaped) { segment += c; escaped = false; continue; }
    if (c === '\\' && quote !== "'") { segment += c; escaped = true; continue; }
    if (quote) { segment += c; if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; segment += c; continue; }
    if (c === ';' || c === '\n' || (c === '&' && command[n + 1] === '&')) {
      segments.push(segment.trim()); segment = ''; if (c === '&') n++; continue;
    }
    if (c === '&' || /[(){}]/.test(c)) return undefined;
    segment += c;
  }
  if (quote || escaped) return undefined;
  segments.push(segment.trim());
  const scope: string[] = [typeof i.cwd === 'string' ? i.cwd : '.'];
  let check: string | undefined;
  const runner = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|typecheck|build|lint)\b|node --test\b|(?:npx )?(?:vitest|jest|mocha|playwright test|tsc)\b|pytest\b|python3? -m (?:pytest|unittest)\b|cargo (?:test|check|build|clippy)\b|go (?:test|vet|build)\b|make (?:test|check)\b|(?:mvn|gradle|\.\/gradlew) (?:test|check|build)\b|(?:bundle exec )?rspec\b|rake test\b|swift test\b|xcodebuild test\b|git (?:diff(?:-index|-files|-tree)?|show|log)(?: (?!--(?:\s|$))[^\s|]+)* --check(?:\s|$))/;
  for (const raw of segments.filter(Boolean)) {
    if (/^cd\s+/.test(raw)) { scope.push(raw.slice(3).trim()); continue; }
    // A newline in a failed pipeline or a second check is ambiguous; do not
    // attribute a compound command's success/failure to one selected suite.
    if (!runner.test(raw)) continue;
    if (check) return undefined;
    check = raw.replace(/\s+2>&1/g, '').replace(/\s+\|\s*(?:tail|head|cat|tee|grep|sed|awk|wc|less)\b.*$/, '').trim();
    if (/[|<>]/.test(check)) return undefined;
    check = JSON.stringify({ v: 2, scope: [...scope], command: check });
  }
  return check;
}
