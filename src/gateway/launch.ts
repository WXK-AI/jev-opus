import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../claude/env.ts';
import { CONFIG_DIR, config } from '../config.ts';
import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import { formatDecision } from '../ui.ts';
import { JevGateway, readStatus } from './server.ts';
import { inlineEffortSettings } from './display.ts';
import { withGatewaySettings, withNarration } from './settings.ts';

export const JEV_MODEL_ID = 'jev/claude-opus-5-5';
export const STATUS_DIR = path.join(CONFIG_DIR, 'status');
export const GATEWAY_LOG = path.join(CONFIG_DIR, 'gateway.log');
export const JOURNAL_DIR = path.join(CONFIG_DIR, 'journal');

/** Env that makes Claude Code route through the gateway and list "Opus 5.5 · Jev" in /model. */
export function gatewayClientEnv(baseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_CUSTOM_MODEL_OPTION: JEV_MODEL_ID,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Opus 5.5 · Jev',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Opus 5.5 with effort re-picked every step by Jev (low/medium/high), cache-safe',
  };
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(GATEWAY_LOG, `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
  } catch {
    // logging is best-effort
  }
}

export function createGateway(jev: JevLike | null, bounds: Bounds, opts: { port?: number; echo?: boolean; trace?: (e: Record<string, unknown>) => void } = {}): JevGateway {
  return new JevGateway({
    jev,
    bounds,
    port: opts.port,
    statusDir: STATUS_DIR,
    journalDir: JOURNAL_DIR,
    upstream: process.env.JEV_GATEWAY_UPSTREAM || undefined,
    trace: opts.trace,
    onDecision: (session, d) => {
      const line = `[${session.slice(0, 8)}] ${formatDecision(d, false)}`;
      appendLog(line);
      if (opts.echo) console.log(line);
    },
    onNotice: (m) => {
      appendLog(`! ${m}`);
      if (opts.echo) console.log(`! ${m}`);
    },
  });
}

/** `jev-opus claude [claude args…]`: gateway in-process + the normal interactive Claude Code on top of it. */
export async function launchClaude(jev: JevLike | null, bounds: Bounds, claudeArgs: string[], trace?: (e: Record<string, unknown>) => void): Promise<number> {
  const gateway = createGateway(jev, bounds, { trace });
  const baseUrl = await gateway.listen();

  const { env } = childEnv(process.env, { connectors: true });
  Object.assign(env, gatewayClientEnv(baseUrl));

  try {
    const cli = fileURLToPath(new URL('../cli.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'), import.meta.url));
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(cli)} statusline`;
    // Opus 5.5 turns most mid-task notes into hidden progress blocks, so narration is opt-in.
    const base = process.env.JEV_OPUS_NARRATION === '1' ? withNarration(claudeArgs) : [...claudeArgs];
    const args = withGatewaySettings(base, {
      ...(process.env.JEV_OPUS_NO_INLINE_EFFORT === '1' ? {} : inlineEffortSettings(baseUrl + gateway.displayHookPath, { toolNotices: process.env.JEV_OPUS_TOOL_NOTICES === '1' })),
      ...(process.env.JEV_OPUS_NO_STATUSLINE === '1' ? {} : { statusLine: { type: 'command' as const, command } }),
    });
    if (!args.some((a) => a === '--model' || a.startsWith('--model='))) args.unshift('--model', JEV_MODEL_ID);

    const child = spawn(config.claudePath ?? 'claude', args, { stdio: 'inherit', env });
    return await new Promise<number>((resolve) => {
      child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
      child.on('error', (err) => {
        console.error(`could not start claude: ${err.message}`);
        resolve(127);
      });
    });
  } finally {
    await gateway.close();
  }
}

/** Claude Code statusLine command: shows the effort Jev picked for this session. */
export async function statusline(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let session = '';
  let model = '';
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: string; model?: { id?: string; display_name?: string } };
    session = input.session_id ?? '';
    // Claude Code reports the resolved display name ("Opus 5.5"), so recognise Jev by its model ID.
    model = `${input.model?.id ?? ''} ${input.model?.display_name ?? ''}`;
  } catch {
    // no input: still print something useful
  }
  const s = session ? readStatus(STATUS_DIR, session) : null;
  if (!s) return void process.stdout.write(`◆ Jev ${/jev\/|Jev/.test(model) ? 'waiting for the first step' : 'off (pick "Opus 5.5 · Jev" in /model)'}`);
  process.stdout.write(formatStatusLine(s));
}

/** "◆ Jev · MEDIUM → HIGH → MEDIUM · verifying": the current prompt's whole path, newest last. */
export function formatStatusLine(s: { effort: string; previous: string | null; trail?: string[]; phase: string; source: string }): string {
  const trail = s.trail?.length ? s.trail : s.previous && s.previous !== s.effort ? [s.previous, s.effort] : [s.effort];
  const shown = trail.length > 6 ? ['…', ...trail.slice(-5)] : trail;
  const path = shown.map((e, i) => (i === shown.length - 1 ? e.toUpperCase() : e.toLowerCase())).join(' → ');
  return `◆ Jev · ${path}${s.phase ? ` · ${s.phase.replaceAll('_', ' ')}` : ''}${s.source === 'heuristic' ? ' · local routing' : ''}`;
}
