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

export const JEV_MODEL_ID = 'jev/claude-opus-5-5';
export const STATUS_DIR = path.join(CONFIG_DIR, 'status');
export const GATEWAY_LOG = path.join(CONFIG_DIR, 'gateway.log');

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

  const args = [...claudeArgs];
  if (!args.some((a) => a === '--model' || a.startsWith('--model='))) args.unshift('--model', JEV_MODEL_ID);
  if (!args.some((a) => a === '--settings' || a.startsWith('--settings=')) && process.env.JEV_OPUS_NO_STATUSLINE !== '1') {
    const cli = fileURLToPath(new URL('../cli.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'), import.meta.url));
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} statusline`;
    args.unshift('--settings', JSON.stringify({ statusLine: { type: 'command', command } }));
  }

  const child = spawn(config.claudePath ?? 'claude', args, { stdio: 'inherit', env });
  const code = await new Promise<number>((resolve) => {
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
    child.on('error', (err) => {
      console.error(`could not start claude: ${err.message}`);
      resolve(127);
    });
  });
  await gateway.close();
  return code;
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
    model = input.model?.display_name ?? input.model?.id ?? '';
  } catch {
    // no input: still print something useful
  }
  const s = session ? readStatus(STATUS_DIR, session) : null;
  if (!s) return void process.stdout.write(`◆ Jev ${model.includes('Jev') ? 'waiting for first step' : 'off (pick "Opus 5.5 · Jev" in /model)'}`);
  const arrow = s.previous && s.previous !== s.effort ? `${s.previous} → ` : '';
  process.stdout.write(`◆ Jev ${arrow}${s.effort.toUpperCase()}${s.phase ? ` · ${s.phase}` : ''}${s.source === 'heuristic' ? ' (heuristic)' : ''}`);
}
