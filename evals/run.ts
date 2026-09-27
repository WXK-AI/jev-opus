#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Mode = 'medium' | 'high' | 'heuristic' | 'jev';
interface Task {
  id: string;
  repository: string;
  ref: string;
  prompt: string;
  setup?: string[];
  verify: string[];
}
interface Manifest {
  tasks: Task[];
  trials?: number;
  modes?: Mode[];
  maxTurns?: number;
  timeoutMs?: number;
}
interface TaskResult {
  task: string;
  trial: number;
  mode: Mode;
  verified: boolean;
  agentSucceeded: boolean;
  costUsd: number | null;
  jevCostUsd: number | null;
  durationMs: number;
  turns: number | null;
  evaluatorUsed: boolean;
  failure?: string;
}

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const MODES: Mode[] = ['medium', 'high', 'heuristic', 'jev'];

function requireInt(value: unknown, label: string, fallback: number, min: number, max: number): number {
  const number = value ?? fallback;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function validate(raw: unknown): Required<Manifest> {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object');
  const value = raw as Manifest;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error('manifest needs at least one task');
  const modes = value.modes ?? MODES;
  if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !MODES.includes(mode)) || new Set(modes).size !== modes.length) {
    throw new Error(`modes must contain unique values from ${MODES.join(', ')}`);
  }
  for (const task of value.tasks) {
    if (!task || !/^[a-zA-Z0-9_-]+$/.test(task.id) || !path.isAbsolute(task.repository) ||
      typeof task.ref !== 'string' || !task.ref || typeof task.prompt !== 'string' || !task.prompt.trim() ||
      !Array.isArray(task.verify) || !task.verify.length || task.verify.some((cmd) => typeof cmd !== 'string' || !cmd.trim()) ||
      (task.setup !== undefined && (!Array.isArray(task.setup) || task.setup.some((cmd) => typeof cmd !== 'string' || !cmd.trim())))) {
      throw new Error('each task needs an id, absolute repository path, git ref, prompt, and verify commands');
    }
  }
  if (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length) throw new Error('task ids must be unique');
  return {
    tasks: value.tasks,
    trials: requireInt(value.trials, 'trials', 1, 1, 100),
    modes,
    maxTurns: requireInt(value.maxTurns, 'maxTurns', 20, 1, 1000),
    timeoutMs: requireInt(value.timeoutMs, 'timeoutMs', 1_800_000, 1_000, 86_400_000),
  };
}

function command(program: string, args: string[], cwd: string, timeout: number, input?: string) {
  return spawnSync(program, args, { cwd, input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
}

function checked(program: string, args: string[], cwd: string, timeout: number): void {
  const result = command(program, args, cwd, timeout);
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr.trim().slice(-300)}`);
}

function runTask(task: Task, trial: number, mode: Mode, settings: Required<Manifest>): TaskResult {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-opus-eval-'));
  const worktree = path.join(temporary, 'repo');
  let added = false;
  const started = Date.now();
  let report: Record<string, unknown> | null = null;
  let failure: string | undefined;
  let verified = false;
  try {
    checked('git', ['worktree', 'add', '--detach', worktree, task.ref], task.repository, 120_000);
    added = true;
    for (const setup of task.setup ?? []) checked('sh', ['-lc', setup], worktree, settings.timeoutMs);
    const args = [CLI, '--json', '--workspace', worktree, '--max-turns', String(settings.maxTurns)];
    if (mode === 'medium' || mode === 'high') args.push('--effort', mode);
    else if (mode === 'heuristic') args.push('--no-jev');
    const run = command(process.execPath, args, worktree, settings.timeoutMs, task.prompt);
    if (run.stdout.trim()) {
      try { report = JSON.parse(run.stdout) as Record<string, unknown>; }
      catch { failure = 'agent did not produce a JSON report'; }
    }
    if (run.error || run.status !== 0) failure ??= run.error?.message ?? `agent exited ${run.status}`;
    verified = true;
    for (const check of task.verify) {
      const result = command('sh', ['-lc', check], worktree, settings.timeoutMs);
      if (result.error || result.status !== 0) { verified = false; break; }
    }
  } catch (err) {
    failure = (err as Error).message;
  } finally {
    if (added) {
      try { checked('git', ['worktree', 'remove', '--force', worktree], task.repository, 120_000); }
      catch (err) { failure = `${failure ? `${failure}; ` : ''}cleanup failed: ${(err as Error).message}`; }
    }
    if (!failure?.includes('cleanup failed')) fs.rmSync(temporary, { recursive: true, force: true });
  }
  const evaluatorUsed = Array.isArray(report?.decisions) && report.decisions.some((decision) => decision?.source === 'jev');
  if (mode === 'jev' && !evaluatorUsed) failure ??= 'Jev mode did not receive a Jev decision; check the configured key';
  return {
    task: task.id, trial, mode,
    verified, agentSucceeded: !!report && report.isError === false && !failure,
    costUsd: typeof report?.costUsd === 'number' ? report.costUsd : null,
    jevCostUsd: typeof report?.jevCostUsd === 'number' ? report.jevCostUsd : null,
    durationMs: Date.now() - started,
    turns: typeof report?.turns === 'number' ? report.turns : null,
    evaluatorUsed,
    ...(failure ? { failure } : {}),
  };
}

function main(): void {
  const [manifestPath, outputPath, option, ...extra] = process.argv.slice(2);
  if (!manifestPath || !outputPath || extra.length || (option && option !== '--dry-run')) {
    throw new Error('usage: node evals/run.ts manifest.json results.jsonl [--dry-run]');
  }
  const settings = validate(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  settings.tasks = settings.tasks.map((task) => {
    const resolved = command('git', ['rev-parse', '--verify', `${task.ref}^{commit}`], task.repository, 30_000);
    if (resolved.error || resolved.status !== 0 || !/^[0-9a-f]{40,64}\s*$/.test(resolved.stdout)) {
      throw new Error(`cannot resolve ${task.id} ref ${task.ref} to a commit`);
    }
    return { ...task, ref: resolved.stdout.trim() };
  });
  if (option === '--dry-run') {
    process.stdout.write(`${settings.tasks.length} tasks × ${settings.trials} trials × ${settings.modes.length} modes = ${settings.tasks.length * settings.trials * settings.modes.length} runs\n`);
    for (const task of settings.tasks) process.stdout.write(`${task.id}: ${task.ref}\n`);
    return;
  }
  const output = path.resolve(outputPath);
  fs.writeFileSync(output, `${JSON.stringify({ kind: 'run', at: new Date().toISOString(), manifest: path.resolve(manifestPath), modes: settings.modes, trials: settings.trials, refs: Object.fromEntries(settings.tasks.map((task) => [task.id, task.ref])) })}\n`, { flag: 'wx', mode: 0o600 });
  const results: TaskResult[] = [];
  for (const task of settings.tasks) {
    for (let trial = 0; trial < settings.trials; trial++) {
      // Rotate order across trials so a transient service change does not
      // always favor the same mode.
      const modes = [...settings.modes.slice(trial % settings.modes.length), ...settings.modes.slice(0, trial % settings.modes.length)];
      for (const mode of modes) {
        const result = runTask(task, trial + 1, mode, settings);
        results.push(result);
        fs.appendFileSync(output, `${JSON.stringify({ kind: 'result', ...result })}\n`);
        process.stderr.write(`${task.id} trial ${trial + 1} ${mode}: ${result.verified && result.agentSucceeded ? 'pass' : 'fail'}\n`);
      }
    }
  }
  const summary = Object.fromEntries(settings.modes.map((mode) => {
    const runs = results.filter((result) => result.mode === mode);
    const complete = runs.filter((result) => result.costUsd !== null);
    return [mode, {
      runs: runs.length,
      successful: runs.filter((result) => result.verified && result.agentSucceeded).length,
      totalCostUsd: complete.reduce((sum, result) => sum + result.costUsd! + (result.jevCostUsd ?? 0), 0),
      costCoverage: complete.length,
      meanDurationMs: Math.round(runs.reduce((sum, result) => sum + result.durationMs, 0) / runs.length),
    }];
  }));
  fs.appendFileSync(output, `${JSON.stringify({ kind: 'summary', modes: summary })}\n`);
  process.stdout.write(`${output}\n`);
}

try { main(); }
catch (err) { console.error((err as Error).message); process.exitCode = 1; }
