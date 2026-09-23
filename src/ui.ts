import readline from 'node:readline';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { Effort } from './effort.ts';
import type { ApiCallInfo, SessionObserver, TaskReport } from './claude/session.ts';
import type { EffortDecision } from './router/types.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'),
  yellow: paint('33'), blue: paint('34'), magenta: paint('35'), cyan: paint('36'),
};

const EFFORT_COLOR: Record<Effort, (s: string) => string> = {
  low: c.green, medium: c.cyan, high: c.yellow, xhigh: c.magenta, max: c.red,
};
export const fmtEffort = (e: Effort) => EFFORT_COLOR[e](c.bold(e.toUpperCase()));

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatDecision(d: EffortDecision, verbose: boolean): string {
  const tag = c.magenta('◆ jev');
  const src = d.source === 'jev' ? c.dim(`(jev ${d.jevLatencyMs}ms)`)
    : d.source === 'pinned' ? c.dim('(pinned)')
      : c.dim(`(heuristic${d.jevError ? `: ${d.jevError}` : ''})`);
  let what: string;
  if (d.kind === 'task' && d.profile) {
    const p = d.profile;
    what = `task ${c.bold(p.taskType)} · difficulty ${p.difficulty.toFixed(1)}/4 · stakes ${p.stakes.toFixed(2)}`;
  } else if (d.signals) {
    const s = d.signals;
    what = `next: ${c.bold(s.phase)} · step ${s.stepDifficulty.toFixed(1)}/4 · stuck ${s.stuck.toFixed(2)}`;
  } else {
    what = d.kind;
  }
  const arrow = d.changed && d.previous
    ? `${fmtEffort(d.previous)} ⇒ ${fmtEffort(d.effort)}`
    : d.changed ? fmtEffort(d.effort) : c.dim(`stays ${d.effort}`);
  let line = `${tag} │ ${what} → ${arrow}  ${src}`;
  if (verbose) line += `\n      ${c.dim(d.reasons.join(' · '))}`;
  return line;
}

/** "high×2 → medium×3 → low" */
export function effortPath(efforts: readonly string[]): string {
  const runs: Array<[string, number]> = [];
  for (const e of efforts) {
    const last = runs[runs.length - 1];
    if (last && last[0] === e) last[1]++;
    else runs.push([e, 1]);
  }
  return runs.map(([e, n]) => (n > 1 ? `${e}×${n}` : e)).join(' → ');
}

export function formatReport(r: TaskReport, jevCostUsd: number): string {
  const totalIn = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
  const hit = totalIn > 0 ? Math.round((100 * r.usage.cacheRead) / totalIn) : 0;
  const changes = r.decisions.filter((d) => d.changed && d.previous !== null).length;
  return [
    c.dim('─'.repeat(60)),
    `${r.isError ? c.red('✗ ' + r.subtype) : c.green('✓ done')} in ${(r.durationMs / 1000).toFixed(1)}s · ${r.callEfforts.length} API calls · ${r.turns} turns · $${r.costUsd.toFixed(4)} Claude + $${jevCostUsd.toFixed(5)} Jev`,
    `  effort path: ${effortPath(r.callEfforts) || '—'}  ${c.dim(`(${changes} mid-prompt change${changes === 1 ? '' : 's'})`)}`,
    `  cache: ${hit}% of input from cache ${c.dim(`(read ${k(r.usage.cacheRead)} · write ${k(r.usage.cacheWrite)} · uncached ${k(r.usage.input)} · out ${k(r.usage.output)})`)}`,
  ].join('\n');
}

export class Terminal {
  private rl: readline.Interface | null = null;
  verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  private get iface(): readline.Interface {
    this.rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return this.rl;
  }

  ask(question: string): Promise<string> {
    return new Promise((resolve) => this.iface.question(question, resolve));
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  observer(): SessionObserver {
    return {
      onInit: ({ model, claudeVersion }) => console.log(c.dim(`claude code ${claudeVersion ?? '?'} · model ${model}`)),
      onDecision: (d) => console.log(formatDecision(d, this.verbose)),
      onAssistantText: (text) => console.log(`\n${text.trim()}\n`),
      onToolUse: (tool, summary) => console.log(`${c.blue('  ▸')} ${c.bold(tool)} ${c.dim(summary)}`),
      onToolResult: (_tool, failed, preview) => {
        if (failed) console.log(`    ${c.red('✗')} ${c.dim(preview)}`);
        else if (this.verbose) console.log(`    ${c.green('✓')} ${c.dim(preview)}`);
      },
      onApiCall: (i: ApiCallInfo) => {
        if (this.verbose) {
          console.log(c.dim(`    · api call @${i.effort} · cache read ${k(i.cacheReadTokens)} · write ${k(i.cacheWriteTokens)} · uncached ${k(i.inputTokens)} · out ${k(i.outputTokens)}`));
        }
      },
      onNotice: (m) => console.log(c.yellow(`  ! ${m}`)),
    };
  }

  /** Interactive approval for tools the permission mode doesn't auto-allow. */
  canUseTool(): CanUseTool {
    return async (toolName, input) => {
      const preview = JSON.stringify(input).slice(0, 300);
      const answer = (await this.ask(`${c.yellow('  ? allow')} ${c.bold(toolName)} ${c.dim(preview)} ${c.yellow('[y/N]')} `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user declined this tool call.' };
    };
  }
}
