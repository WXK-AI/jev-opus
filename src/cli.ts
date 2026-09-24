#!/usr/bin/env node
import { auditJournal, formatAudit } from './gateway/audit.ts';
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
import { createGateway, GATEWAY_LOG, gatewayClientEnv, JEV_MODEL_ID, launchClaude, logToGateway, statusline } from './gateway/launch.ts';
import { inlineEffortSettings } from './gateway/display.ts';
import { createTrace } from './trace.ts';
import { c, fmtEffort, formatDecision, formatReport, Terminal } from './ui.ts';

const HELP = `jev-opus — Claude Opus 5.5 (via Claude Code) with effort steered turn-by-turn by Jev

Usage:
  jev-opus "prompt"            run one prompt, then exit
  jev-opus                     interactive session (effort re-routed every prompt and every tool step)
  jev-opus --route-only "p"    show Jev's effort decision for a prompt without calling Claude
  jev-opus doctor              check Claude Code, credentials, and the Jev API
  jev-opus init                create ${CONFIG_ENV_FILE} (asks for your Jev key)

  jev-opus claude [args…]      your normal interactive Claude Code, with "Opus 5.5 · Jev" selected in /model
  jev-opus gateway [--port n]  run the Jev gateway for VS Code / JetBrains / Agent SDK (ANTHROPIC_BASE_URL)
  jev-opus audit [D-id] [--json]  inspect decisions, attempts, usage, and visual annotations
  jev-opus statusline          Claude Code statusLine command showing Jev's current effort

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
  const argv = process.argv.slice(2);
  if (argv[0] === 'claude') {
    // Everything after `claude` belongs to Claude Code; routing bounds come from the config/env.
    const trace = createTrace(config.traceDir, logToGateway); // the TUI owns the terminal: log, don't print
    const jev = (await jevClient())!;
    if (!jev.enabled) console.error(c.yellow('No Jev key (JEV_API_KEY or OPENROUTER_API_KEY) — routing with local heuristics (run `jev-opus init`).'));
    process.exitCode = await launchClaude(jev, { min: config.minEffort, max: config.maxEffort }, argv.slice(1), trace.write);
    return;
  }
  if (argv[0] === 'statusline') return statusline();

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
      port: { type: 'string' },
    },
  });
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(packageVersion());
  if (positionals[0] === 'init') return void (await init());
  if (positionals[0] === 'audit') {
    const report = auditJournal(path.join(CONFIG_DIR, 'journal'), positionals[1]);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatAudit(report));
    return;
  }

  const bounds = { min: effortArg('min', values.min, config.minEffort), max: effortArg('max', values.max, config.maxEffort) };
  const pinned = values.effort ? effortArg('effort', values.effort, 'medium') : null;
  const jev = positionals[0] === 'doctor' || values['route-only'] ? (values['no-jev'] ? null : new JevClient()) : await jevClient(values['no-jev']);
  const router = new EffortRouter({ jev, bounds, pinned });
  const terminal = new Terminal(values.verbose ?? false, values.json ?? false);
  // --json: stdout carries only the JSON report; every notice goes to stderr.
  const notice = values.json ? console.error : console.log;

  if (positionals[0] === 'doctor') return doctor(router, jev, values.model ?? config.model, values.settings);
  if (positionals[0] === 'gateway') return gateway(jev, bounds, Number(values.port ?? 47821));

  let prompt = positionals.join(' ').trim();
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();

  if (values['route-only']) {
    if (!prompt) throw new Error('--route-only needs a prompt');
    const d = await router.routeTask(prompt, null);
    console.log(values.json ? JSON.stringify(d, null, 2) : formatDecision(d, true));
    return;
  }

  if (!router.usingJev && !pinned) {
    notice(c.yellow(values['no-jev'] ? 'Jev disabled — routing with local heuristics.' : 'No Jev key (JEV_API_KEY or OPENROUTER_API_KEY) — routing with local heuristics.'));
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

  notice(c.dim(`workspace ${cwd} · effort ${bounds.min}..${bounds.max}${pinned ? ` · pinned ${pinned}` : ''} · auth: ${credential}`));

  const run = async (p: string): Promise<TaskReport | null> => {
    const jevBefore = jev?.costUsd ?? 0;
    try {
      const report = await session.send(p);
      const jevCostUsd = (jev?.costUsd ?? 0) - jevBefore; // jev.costUsd is cumulative — the task's share is the delta
      if (values.json) console.log(JSON.stringify({ ...report, jevCostUsd }, null, 2));
      else {
        if (report.isError) console.log(c.red(report.result));
        console.log(formatReport(report, jevCostUsd));
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
    await repl(session, router, terminal, run, notice);
  } finally {
    terminal.close();
    await session.close();
    if (values.verbose) notice(c.dim(`trace: ${trace.file}`));
  }
}

async function gateway(jev: JevClient | null, bounds: { min: Effort; max: Effort }, port: number): Promise<void> {
  const trace = createTrace(config.traceDir);
  const gw = createGateway(jev && jev.enabled ? jev : null, bounds, { port, echo: true, trace: trace.write });
  const url = await gw.listen();
  const env = gatewayClientEnv(url);
  console.log(`Jev gateway on ${url} · effort ${bounds.min}..${bounds.max} · ${jev?.enabled ? 'Jev' : 'heuristics'} · log ${GATEWAY_LOG}`);
  console.log(c.dim('Point Claude Code at it (CLI shell, VS Code "claudeCode.environmentVariables", Agent SDK env):'));
  for (const [k, v] of Object.entries(env)) console.log(c.dim(`  ${k}=${v}`));
  console.log(c.dim(`then pick "Opus 5.5 · Jev" in /model (or --model ${JEV_MODEL_ID}). Ctrl-C to stop.`));
  console.log(c.dim('For inline effort badges, merge these session hooks into your Claude Code settings (valid while this gateway runs):'));
  console.log(JSON.stringify(inlineEffortSettings(url + gw.displayHookPath, { toolNotices: process.env.JEV_OPUS_TOOL_NOTICES !== '0' }), null, 2));
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await gw.close();
}

function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function init(): Promise<string> {
  if (fs.existsSync(CONFIG_ENV_FILE)) {
    console.log(`${CONFIG_ENV_FILE} already exists — edit it directly.`);
    return '';
  }
  let key = process.env.JEV_API_KEY ?? '';
  if (!key && process.stdin.isTTY) {
    const t = new Terminal(false);
    key = (await t.ask('Jev key: a TypeSafe key (apikey_…) or an OpenRouter key (sk-or-…), empty to skip: ')).trim();
    t.close();
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_ENV_FILE, [
    '# jev-opus configuration',
    key.startsWith('sk-or-') ? `OPENROUTER_API_KEY=${key}\nJEV_PROVIDER=openrouter` : `JEV_API_KEY=${key}`,
    '# or use Jev through OpenRouter: OPENROUTER_API_KEY=sk-or-… and JEV_PROVIDER=openrouter',
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
  return key;
}

/**
 * First run in a terminal with no key and no config file: ask once, right
 * there. Skipping writes the config file too, so it never asks again.
 */
async function jevClient(disabled = false): Promise<JevClient | null> {
  if (disabled) return null;
  const jev = new JevClient();
  if (jev.enabled || !process.stdin.isTTY || !process.stdout.isTTY || fs.existsSync(CONFIG_ENV_FILE)) return jev;
  console.log(c.bold('First run: jev-opus uses the Jev API to pick Claude\'s effort level.'));
  console.log(c.dim('Paste a TypeSafe key (https://typesafe.ai) or an OpenRouter key, or press Enter to skip and use local routing.'));
  const key = await init();
  if (!key) return jev;
  return key.startsWith('sk-or-') ? new JevClient({ provider: 'openrouter', apiKey: key }) : new JevClient({ provider: 'typesafe', apiKey: key });
}

async function repl(
  session: JevOpusSession,
  router: EffortRouter,
  terminal: Terminal,
  run: (p: string) => Promise<TaskReport | null>,
  notice: (s: string) => void,
): Promise<void> {
  notice(c.dim('Type a prompt. /pin <effort> · /auto · /bounds <min> <max> · /status · /exit'));
  for (;;) {
    const line = (await terminal.ask(c.bold('\n› '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') return;
    if (line.startsWith('/pin')) {
      const e = line.split(/\s+/)[1];
      if (!isEffort(e)) { notice(`usage: /pin ${EFFORT_LEVELS.join('|')}`); continue; }
      await session.setPinned(e);
      notice(`effort pinned at ${fmtEffort(e)}`);
      continue;
    }
    if (line === '/auto') {
      await session.setPinned(null);
      notice(`Jev routing ${router.usingJev ? 'on' : 'on (heuristics)'}`);
      continue;
    }
    if (line.startsWith('/bounds')) {
      const [, lo, hi] = line.split(/\s+/);
      if (!isEffort(lo) || !isEffort(hi)) { notice('usage: /bounds <min> <max>'); continue; }
      router.bounds = { min: lo, max: hi };
      notice(`effort bounds ${lo}..${hi}`);
      continue;
    }
    if (line === '/status') {
      const cur = session.currentEffort;
      notice(`effort ${cur ? fmtEffort(cur) : '—'} · bounds ${router.bounds.min}..${router.bounds.max} · ${router.pinned ? `pinned ${router.pinned}` : router.usingJev ? 'Jev routing' : 'heuristic routing'}`);
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
