#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from './claude/env.ts';
import { JevOpusSession, type TaskReport } from './claude/session.ts';
import { CONFIG_DIR, CONFIG_ENV_FILE, PROJECT_ROOT, config } from './config.ts';
import { EFFORT_LEVELS, isEffort, type Effort } from './effort.ts';
import { JevClient } from './jev/client.ts';
import { EffortRouter } from './router/router.ts';
import { createTrace } from './trace.ts';
import { c, fmtEffort, formatDecision, formatReport, Terminal } from './ui.ts';

const HELP = `jev-opus — Claude Opus 5.5 (via Claude Code) with effort steered turn-by-turn by Jev

Usage:
  jev-opus "prompt"            run one prompt, then exit
  jev-opus                     interactive session (effort re-routed every prompt and every tool step)
  jev-opus --route-only "p"    show Jev's effort decision for a prompt without calling Claude
  jev-opus doctor              check Claude Code, credentials, and the Jev API
  jev-opus init                create ${CONFIG_ENV_FILE} (asks for your Jev key)

Options:
  -w, --workspace <dir>        directory Claude works in (default: current directory)
  -m, --model <id>             model (default: ${config.model})
      --min <effort>           lowest effort Jev may pick (default: ${config.minEffort})
      --max <effort>           highest effort Jev may pick (default: ${config.maxEffort})
      --effort <effort>        pin one effort level; disables routing
      --no-jev                 route with local heuristics only
      --permission-mode <m>    default | acceptEdits | auto | plan | dontAsk | bypassPermissions (default: acceptEdits)
      --yolo                   same as --permission-mode bypassPermissions
      --settings <list>        Claude Code setting sources to load (default: project,local; add "user" to load ~/.claude)
      --max-turns <n>          stop after n agent turns
  -v, --verbose                show routing reasons, every tool result, and per-call cache stats
      --json                   print the final report as JSON

Interactive commands: /pin <effort>  /auto  /bounds <min> <max>  /status  /exit
Effort levels: ${EFFORT_LEVELS.join(', ')}`;

function effortArg(name: string, v: string | undefined, fallback: Effort): Effort {
  if (v === undefined) return fallback;
  if (!isEffort(v)) {
    console.error(`--${name} must be one of ${EFFORT_LEVELS.join(', ')}`);
    process.exit(2);
  }
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      model: { type: 'string', short: 'm' },
      min: { type: 'string' },
      max: { type: 'string' },
      effort: { type: 'string' },
      'no-jev': { type: 'boolean' },
      'permission-mode': { type: 'string' },
      yolo: { type: 'boolean' },
      settings: { type: 'string' },
      'max-turns': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      'route-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(packageVersion());
  if (positionals[0] === 'init') return init();

  const bounds = { min: effortArg('min', values.min, config.minEffort), max: effortArg('max', values.max, config.maxEffort) };
  const pinned = values.effort ? effortArg('effort', values.effort, 'medium') : null;
  const jev = values['no-jev'] ? null : new JevClient();
  const router = new EffortRouter({ jev, bounds, pinned });
  const terminal = new Terminal(values.verbose ?? false);

  if (positionals[0] === 'doctor') return doctor(router, jev, values.model ?? config.model, values.settings);

  let prompt = positionals.join(' ').trim();
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();

  if (values['route-only']) {
    if (!prompt) throw new Error('--route-only needs a prompt');
    const d = await router.routeTask(prompt, null);
    console.log(formatDecision(d, true));
    return;
  }

  if (!router.usingJev && !pinned) {
    console.log(c.yellow(values['no-jev'] ? 'Jev disabled — routing with local heuristics.' : 'JEV_API_KEY not set — routing with local heuristics.'));
  }

  const permissionMode = (values.yolo ? 'bypassPermissions' : values['permission-mode'] ?? 'acceptEdits') as PermissionMode;
  const settingSources = (values.settings ?? 'project,local').split(',').map((s) => s.trim()).filter(Boolean) as SettingSource[];
  const { env, credential } = childEnv();
  const trace = createTrace(config.traceDir);
  const cwd = path.resolve(values.workspace ?? process.cwd());
  trace.write({ event: 'session', cwd, model: values.model ?? config.model, bounds, pinned, credential, jev: router.usingJev });

  const session = new JevOpusSession({
    router,
    cwd,
    model: values.model ?? config.model,
    env,
    permissionMode,
    canUseTool: process.stdin.isTTY && permissionMode !== 'bypassPermissions' ? terminal.canUseTool() : undefined,
    settingSources,
    claudePath: config.claudePath,
    maxTurns: values['max-turns'] ? Number(values['max-turns']) : undefined,
    observer: terminal.observer(),
    trace: trace.write,
  });

  console.log(c.dim(`workspace ${cwd} · effort ${bounds.min}..${bounds.max}${pinned ? ` · pinned ${pinned}` : ''} · auth: ${credential}`));

  const run = async (p: string): Promise<TaskReport | null> => {
    try {
      const report = await session.send(p);
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        if (report.isError) console.log(c.red(report.result));
        console.log(formatReport(report, jev?.costUsd ?? 0));
      }
      return report;
    } catch (err) {
      console.error(c.red(`error: ${(err as Error).message}`));
      return null;
    }
  };

  try {
    if (prompt) {
      const report = await run(prompt);
      process.exitCode = report && !report.isError ? 0 : 1;
      return;
    }
    await repl(session, router, terminal, run);
  } finally {
    terminal.close();
    await session.close();
    if (values.verbose) console.log(c.dim(`trace: ${trace.file}`));
  }
}

function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function init(): Promise<void> {
  if (fs.existsSync(CONFIG_ENV_FILE)) {
    console.log(`${CONFIG_ENV_FILE} already exists — edit it directly.`);
    return;
  }
  let key = process.env.JEV_API_KEY ?? '';
  if (!key && process.stdin.isTTY) {
    const t = new Terminal(false);
    key = (await t.ask('TypeSafe Jev API key (apikey_…, empty to skip): ')).trim();
    t.close();
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_ENV_FILE, [
    '# jev-opus configuration',
    `JEV_API_KEY=${key}`,
    '# JEV_BASE_URL=https://api.typesafe.ai/v1/systemone',
    '# JEV_MODEL=jev-latest',
    '',
    '# Claude credential for the Claude Code child process. Leave all empty to use your `claude auth login`.',
    '# ANTHROPIC_API_KEY=',
    '# CLAUDE_CODE_OAUTH_TOKEN=',
    '',
    '# JEV_OPUS_MODEL=claude-opus-5-5',
    '# JEV_OPUS_MIN_EFFORT=low',
    '# JEV_OPUS_MAX_EFFORT=high',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`wrote ${CONFIG_ENV_FILE}${key ? '' : ' (add JEV_API_KEY to enable Jev routing)'}\nnext: jev-opus doctor`);
}

async function repl(
  session: JevOpusSession,
  router: EffortRouter,
  terminal: Terminal,
  run: (p: string) => Promise<TaskReport | null>,
): Promise<void> {
  console.log(c.dim('Type a prompt. /pin <effort> · /auto · /bounds <min> <max> · /status · /exit'));
  for (;;) {
    const line = (await terminal.ask(c.bold('\n› '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') return;
    if (line.startsWith('/pin')) {
      const e = line.split(/\s+/)[1];
      if (!isEffort(e)) { console.log(`usage: /pin ${EFFORT_LEVELS.join('|')}`); continue; }
      await session.setPinned(e);
      console.log(`effort pinned at ${fmtEffort(e)}`);
      continue;
    }
    if (line === '/auto') {
      await session.setPinned(null);
      console.log(`Jev routing ${router.usingJev ? 'on' : 'on (heuristics)'}`);
      continue;
    }
    if (line.startsWith('/bounds')) {
      const [, lo, hi] = line.split(/\s+/);
      if (!isEffort(lo) || !isEffort(hi)) { console.log('usage: /bounds <min> <max>'); continue; }
      router.bounds = { min: lo, max: hi };
      console.log(`effort bounds ${lo}..${hi}`);
      continue;
    }
    if (line === '/status') {
      const cur = session.currentEffort;
      console.log(`effort ${cur ? fmtEffort(cur) : '—'} · bounds ${router.bounds.min}..${router.bounds.max} · ${router.pinned ? `pinned ${router.pinned}` : router.usingJev ? 'Jev routing' : 'heuristic routing'}`);
      continue;
    }
    await run(line);
  }
}

async function doctor(router: EffortRouter, jev: JevClient | null, model: string, settings?: string): Promise<void> {
  const ok = (m: string) => console.log(`${c.green('✓')} ${m}`);
  const bad = (m: string) => console.log(`${c.red('✗')} ${m}`);
  let failures = 0;

  const claudeBin = config.claudePath ?? 'claude';
  const { env, credential } = childEnv();
  try {
    const v = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', env }).trim();
    ok(`Claude Code: ${v} (${claudeBin})`);
  } catch (err) {
    failures++;
    bad(`Claude Code not runnable at "${claudeBin}": ${(err as Error).message}`);
  }
  console.log(`  credential for Claude: ${credential}`);

  if (jev) {
    const d = await router.routeTask('Fix the race condition in our job queue that drops messages under load', null);
    if (d.source === 'jev') ok(`Jev API: ${d.profile?.taskType}, difficulty ${d.profile?.difficulty.toFixed(1)} → ${d.effort} in ${d.jevLatencyMs}ms`);
    else { failures++; bad(`Jev API: ${d.jevError ?? 'no answer'}`); }
  } else {
    bad('Jev disabled (--no-jev or JEV_API_KEY unset)');
  }

  const session = new JevOpusSession({
    router: new EffortRouter({ jev: null, bounds: { min: 'low', max: 'low' }, pinned: 'low' }),
    cwd: process.cwd(),
    model,
    env,
    permissionMode: 'dontAsk',
    settingSources: (settings ?? 'project,local').split(',') as SettingSource[],
    claudePath: config.claudePath,
    maxTurns: 1,
  });
  try {
    const r = await session.send('Reply with exactly: ok');
    if (r.isError) { failures++; bad(`Claude (${model}): ${r.result}`); }
    else ok(`Claude (${model}) answered "${r.result.trim().slice(0, 40)}" at effort low · $${r.costUsd.toFixed(4)}`);
  } catch (err) {
    failures++;
    bad(`Claude (${model}): ${(err as Error).message}`);
  } finally {
    await session.close();
  }
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
