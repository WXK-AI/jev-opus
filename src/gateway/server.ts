import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Effort } from '../effort.ts';
import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import { EffortRouter } from '../router/router.ts';
import type { EffortDecision, TaskProfile } from '../router/types.ts';
import { isEffort } from '../effort.ts';
import { EffortDisplay } from './display.ts';
import {
  addBeta, applyInsertions, clientEffort, hasToolResults, isJevModel, lastIndexOfRole, lastPrompt,
  lastToolRound, prefixHashes, stripJevModel, userText, type Insertion, type Message,
} from './transcript.ts';

/**
 * Local Anthropic-Messages gateway. Claude Code (CLI, IDE extensions, Agent SDK)
 * points ANTHROPIC_BASE_URL here and picks the "jev/…" model in /model.
 * Requests for that model get their prefix stripped and a Jev-chosen effort
 * inserted as a per-message effort statement. Everything else passes through
 * byte-for-byte. Credentials are forwarded unchanged and never logged.
 */

export interface GatewayOptions {
  jev: JevLike | null;
  bounds: Bounds;
  upstream?: string;
  port?: number;
  host?: string;
  statusDir?: string;
  onDecision?: (session: string, d: EffortDecision) => void;
  onNotice?: (message: string) => void;
  trace?: (event: Record<string, unknown>) => void;
  maxThreads?: number;
}

interface Thread {
  router: EffortRouter;
  insertions: Insertion[];
  /** length of Claude Code's messages array at the last routing decision */
  decidedAt: number;
  prompt: string;
  profile: TaskProfile | null;
  turn: number;
  consecutiveFailures: number;
  trajectory: string[];
  manual: boolean;
  /** effort this gateway last put in force */
  effort: Effort | null;
  /** last level Claude Code itself stated (its /effort setting) */
  clientEffort: Effort | null;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export class JevGateway {
  /** Ephemeral local endpoint; hook payloads are never forwarded upstream. */
  readonly displayHookPath = `/_jev/hooks/${randomUUID()}`;
  private readonly display = new EffortDisplay();
  private readonly opts: GatewayOptions;
  private readonly upstream: string;
  private readonly threads = new Map<string, Thread>();
  private server: http.Server | null = null;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.upstream = (opts.upstream ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.opts.onNotice?.(`gateway error: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `jev gateway: ${(err as Error).message}` } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port ?? 0, this.opts.host ?? '127.0.0.1', resolve));
    const a = this.server.address() as AddressInfo;
    return `http://${a.address}:${a.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if ((req.url ?? '').startsWith('/_jev/')) {
      if (req.method !== 'POST' || req.url !== this.displayHookPath) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 1_048_576) { res.writeHead(413).end(); return; }
        chunks.push(c as Buffer);
      }
      let output = {};
      try { output = this.display.handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* invalid hook: no UI change */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(output));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Buffer | undefined = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const url = req.url ?? '/';
    const pathname = url.split('?')[0]!;

    if (req.method === 'POST' && body && (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens')) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        parsed = null; // not JSON: pass through untouched
      }
      if (parsed && process.env.JEV_GATEWAY_DEBUG === '1') {
        const msgs = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
        const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
        const shape = Array.isArray(parsed.messages)
          ? (parsed.messages as Message[]).map((m) => `${m.role}${m.output_config ? `{${JSON.stringify(m.output_config)}}` : ''}[${Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).map((b) => b.type).join('+') : typeof m.content}]`).join(' ')
          : '';
        this.opts.onNotice?.(`debug ${pathname} model=${String(parsed.model)} messages=${msgs} tools=${tools} session=${headers['x-claude-code-session-id'] ?? '-'} agent=${headers['x-claude-code-agent-id'] ?? '-'} top=${JSON.stringify(parsed.output_config ?? null)} beta=${headers['anthropic-beta'] ?? ''} :: ${shape}`);
      }
      if (parsed && isJevModel(parsed.model)) {
        parsed.model = stripJevModel(parsed.model);
        if (pathname === '/v1/messages' && Array.isArray(parsed.messages) && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
          parsed.messages = await this.route(headers, parsed);
          headers['anthropic-beta'] = addBeta(headers['anthropic-beta']);
        }
        body = Buffer.from(JSON.stringify(parsed));
      } else if (parsed && pathname === '/v1/messages' && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        // Model switches must not label the next model's responses with a stale Jev decision.
        this.display.clear(headers['x-claude-code-session-id'] ?? 'no-session', headers['x-claude-code-agent-id'] ?? 'main');
      }
    }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const up = await fetch(this.upstream + url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' || !body ? undefined : new Uint8Array(body),
      signal: controller.signal,
      redirect: 'manual',
    });

    const outHeaders: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) outHeaders[k] = v; });

    if (pathname === '/v1/models' && req.method === 'GET' && up.ok) {
      const data = (await up.json()) as { data?: Array<Record<string, unknown>> };
      if (Array.isArray(data.data)) {
        data.data.unshift({ id: 'jev/claude-opus-5-5', display_name: 'Opus 5.5 · Jev', description: 'Opus 5.5 with effort re-picked every step by Jev', type: 'model' });
      }
      res.writeHead(up.status, { ...outHeaders, 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    res.writeHead(up.status, outHeaders);
    if (!up.body) return void res.end();
    Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).pipe(res);
  }

  /** Decide effort for this request and return the messages with all insertions replayed. */
  private async route(headers: Record<string, string>, body: Record<string, unknown>): Promise<Message[]> {
    const messages = body.messages as Message[];
    const session = headers['x-claude-code-session-id'] ?? 'no-session';
    const agent = headers['x-claude-code-agent-id'] ?? 'main';
    const hashes = prefixHashes(messages);
    const key = `${session}|${agent}|${hashes[1]?.slice(0, 16) ?? 'empty'}`;
    const t = this.thread(key);

    // Keep only insertions whose prefix is still Claude Code's history (compaction or /rewind drop the rest).
    const kept = t.insertions.filter((ins) => ins.index <= messages.length && hashes[ins.index] === ins.prefixHash);
    const lastUser = lastIndexOfRole(messages, 'user');
    if (kept.length !== t.insertions.length || t.decidedAt > lastUser + 1) {
      t.insertions = kept;
      t.decidedAt = Math.min(t.decidedAt, Math.max(0, lastUser));
      t.effort = null;
    }
    if (lastUser < 0 || lastUser < t.decidedAt) return applyInsertions(messages, t.insertions); // retry: replay only
    t.decidedAt = lastUser + 1;

    const last = messages[lastUser];
    const prompting = !hasToolResults(last) && userText(last).length > 0;

    // Claude Code states its own /effort level as a per-turn statement. A *change* in that value is the user
    // choosing a level by hand: honor it for the rest of this prompt.
    const client = clientEffort(messages);
    const topLevel = (body.output_config as { effort?: unknown } | undefined)?.effort;
    if (client && t.clientEffort !== null && client.effort !== t.clientEffort) t.manual = true;
    else if (prompting) t.manual = false;
    if (client) t.clientEffort = client.effort;
    const current: Effort = t.effort ?? client?.effort ?? (isEffort(topLevel) ? topLevel : 'medium');
    if (t.manual) {
      t.effort = client?.effort ?? current;
      const manual: EffortDecision = {
        kind: prompting ? 'task' : 'step', effort: t.effort, previous: current,
        changed: t.effort !== current, reasons: ['manual override'], source: 'pinned', jevLatencyMs: 0,
      };
      this.display.record(session, agent, manual);
      this.writeStatus(session, agent, manual);
      return applyInsertions(messages, t.insertions);
    }

    let decision: EffortDecision;
    if (prompting || !t.profile) {
      t.prompt = prompting ? userText(last) : lastPrompt(messages);
      t.turn = 0;
      t.consecutiveFailures = 0;
      t.trajectory = [];
      decision = await t.router.routeTask(t.prompt || '(continuing an earlier task)', current);
      t.profile = decision.profile ?? t.router.lastProfileFallback(t.prompt);
    } else {
      const { note, batch } = lastToolRound(messages.slice(0, lastUser + 1));
      t.turn += 1;
      t.consecutiveFailures = batch.some((c) => c.failed) ? t.consecutiveFailures + 1 : 0;
      decision = await t.router.routeStep({
        prompt: t.prompt, profile: t.profile, turn: t.turn, current,
        consecutiveFailures: t.consecutiveFailures, assistantNote: note, lastBatch: batch, trajectory: t.trajectory,
      });
      t.trajectory.push(`step ${t.turn} @${current}: ${batch.map((c) => `${c.tool} ${c.summary.slice(0, 60)} ${c.failed ? 'FAILED' : 'ok'}`).join('; ')}`);
    }

    // State the level right before the user turn it governs. If Claude Code's own statement trails that turn,
    // restate ours after it too, so ours is the last word however the API orders trailing statements.
    const clientChoseThisTurn = client !== null && client.index > lastUser;
    if (decision.effort !== current || (clientChoseThisTurn && decision.effort !== client.effort)) {
      t.insertions.push({ index: lastUser, effort: decision.effort, prefixHash: hashes[lastUser]! });
      if (clientChoseThisTurn) t.insertions.push({ index: messages.length, effort: decision.effort, prefixHash: hashes[messages.length]! });
    }
    t.effort = decision.effort;
    const final = { ...decision, previous: current, changed: decision.effort !== current };
    this.display.record(session, agent, final);
    this.opts.onDecision?.(session, final);
    this.opts.trace?.({ event: 'gateway_decision', session, agent, index: lastUser, ...final });
    this.writeStatus(session, agent, final);
    return applyInsertions(messages, t.insertions);
  }

  private thread(key: string): Thread {
    let t = this.threads.get(key);
    if (t) {
      this.threads.delete(key); // LRU: re-insert as most recent
      this.threads.set(key, t);
      return t;
    }
    t = {
      router: new EffortRouter({ jev: this.opts.jev, bounds: this.opts.bounds }),
      insertions: [], decidedAt: 0, prompt: '', profile: null, turn: 0, consecutiveFailures: 0, trajectory: [], manual: false, effort: null, clientEffort: null,
    };
    this.threads.set(key, t);
    const max = this.opts.maxThreads ?? 256;
    while (this.threads.size > max) this.threads.delete(this.threads.keys().next().value!);
    return t;
  }

  private writeStatus(session: string, agent: string, d: EffortDecision): void {
    if (!this.opts.statusDir || agent !== 'main' || !/^[\w-]+$/.test(session)) return;
    try {
      fs.mkdirSync(this.opts.statusDir, { recursive: true });
      const phase = d.signals?.phase ?? d.profile?.taskType ?? '';
      fs.writeFileSync(path.join(this.opts.statusDir, `${session}.json`), JSON.stringify({ effort: d.effort, previous: d.previous, phase, source: d.source, at: Date.now() }));
    } catch {
      // the statusline is cosmetic
    }
  }
}

export function readStatus(statusDir: string, session: string): { effort: Effort; previous: Effort | null; phase: string; source: string; at: number } | null {
  if (!/^[\w-]+$/.test(session)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(statusDir, `${session}.json`), 'utf8'));
  } catch {
    return null;
  }
}
