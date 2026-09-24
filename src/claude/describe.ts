/** One-line renderings of Claude Code tool inputs/results for the UI and for Jev's state. */

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

const FAIL_TEXT = /(exit code [1-9]\d*|\bError:|\bFAILED\b|\bFAIL\b|Traceback \(most recent call last\)|\bpanicked at\b|\b[1-9]\d* (failing|failed)\b|^# fail [1-9]|^\s*✖ |command not found|No such file or directory)/m;

/** Best-effort failure detection for a successful-looking tool response. */
export function looksFailed(tool: string, response: unknown): boolean {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    if (r.is_error === true || r.success === false || r.interrupted === true) return true;
    for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) {
      if (typeof r[k] === 'number' && r[k] !== 0) return true;
    }
  }
  if (tool !== 'Bash') return false;
  return FAIL_TEXT.test(stringifyResult(response).slice(0, 4000));
}

/**
 * The test or check suite a shell command runs, read from the FULL command
 * (summaries are clipped, and Claude often chains setup, fixes and the test
 * run into one command). The last runner in the command wins.
 */
const RUNNERS: ReadonlyArray<[RegExp, string]> = [
  [/\b(npm|pnpm|yarn|bun) (run )?test\b/, 'npm test'],
  [/\bnode --test\b/, 'node --test'],
  [/\bnpx (vitest|jest|mocha|playwright test)\b|\b(vitest|jest|mocha)\b/, 'js tests'],
  [/\bpytest\b|python3? -m (pytest|unittest)\b/, 'pytest'],
  [/\bcargo (test|check|build|clippy)\b/, 'cargo'],
  [/\bgo (test|vet|build)\b/, 'go'],
  [/\b(npx )?tsc\b|\bnpm run (typecheck|build|lint)\b/, 'typecheck/build'],
  [/\bmake (test|check)\b/, 'make test'],
  [/\b(mvn|gradle|\.\/gradlew) (test|check|build)\b/, 'jvm'],
  [/\b(rspec|bundle exec rspec|rake test)\b/, 'ruby tests'],
  [/\bswift test\b|\bxcodebuild test\b/, 'swift tests'],
];

export function testRunner(tool: string, input: unknown): string | undefined {
  if (tool !== 'Bash') return undefined;
  const cmd = String(((input ?? {}) as Record<string, unknown>).command ?? '').toLowerCase();
  let best: { at: number; name: string } | undefined;
  for (const [re, name] of RUNNERS) {
    for (const m of cmd.matchAll(new RegExp(re.source, 'g'))) {
      if (!best || m.index! >= best.at) best = { at: m.index!, name };
    }
  }
  return best?.name;
}
