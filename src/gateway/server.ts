import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Effort } from '../effort.ts';
import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import { STEP_SET_VERSION, TASK_SET_VERSION } from '../router/questions.ts';
import { EffortRouter } from '../router/router.ts';
import type { EffortDecision, TaskProfile } from '../router/types.ts';
import { isEffort } from '../effort.ts';
import { EffortDisplay } from './display.ts';
import { Journal, type JournalLine, type JournalRecord, type JournalStatus, type JournalUsage } from './journal.ts';
import {
  addBeta, applyInsertions, clientEffort, hasToolResults, isJevModel, lastIndexOfRole, lastPrompt,
  lastToolRound, prefixHashes, requestFingerprint, stripJevModel, userText, type Insertion, type Message,
} from './transcript.ts';

/**
 * Local Anthropic-Messages gateway. Claude Code (CLI, IDE extensions, Agent SDK)
 * points ANTHROPIC_BASE_URL here and picks the "jev/…" model in /model.
 * Requests for that model get their prefix stripped and a Jev-chosen effort
 * inserted as a per-message effort statement. Everything else passes through
 * byte-for-byte. Credentials are forwarded unchanged and never logged.
 *
 * Routing decisions are serialized per conversation branch and single-flighted
 * by request fingerprint: an identical request awaits and reuses the prepared
 * transformation instead of routing twice. Every prepared transformation is
 * written to a durable JSONL journal before it is forwarded upstream, so a
 * thread-cache eviction or a gateway restart replays exactly the statements the
 * upstream model saw. A bounded copy of each routed response is parsed for
 * usage and journaled against the decision ID.
 */

export interface GatewayOptions {
  jev: JevLike | null;
  bounds: Bounds;
  upstream?: string;
  port?: number;
  host?: string;
  statusDir?: string;
  /** durable journal directory; without it the gateway keeps no journal (tests) */
  journalDir?: string;
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
  /** serializes routing decisions on this branch */
  queue: Promise<unknown>;
  /** request fingerprint → in-flight or prepared transformation to reuse */
  prepared: Map<string, Promise<Prepared>>;
  /** journaled decisions (all branches) for common-ancestor lookup */
  records: JournalRecord[];
  /** the record whose post-decision state the fields above reflect */
  tip: JournalRecord | null;
}

interface Prepared {
  /** absent when nothing was decided (no user message → replay only) */
  decisionId?: string;
  /** cumulative insertions as forwarded for that boundary — immutable */
  insertions: Insertion[];
}

interface Routed {
  messages: Message[];
  decisionId?: string;
  key?: string;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const POLICY_VERSION = `gateway.v1+${TASK_SET_VERSION}+${STEP_SET_VERSION}`;
/** cap on the tee'd copy of a routed response kept for usage parsing */
const TELEMETRY_CAP = 256 * 1024;
const PREPARED_CAP = 512;

export class JevGateway {
  /** Ephemeral local endpoint; hook payloads are never forwarded upstream. */
  readonly displayHookPath = `/_jev/hooks/${randomUUID()}`;
  private readonly display = new EffortDisplay();
  private readonly opts: GatewayOptions;
  private readonly upstream: string;
  private readonly journal: Journal | null;
  private readonly threads = new Map<string, Thread>();
  private server: http.Server | null = null;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.upstream = (opts.upstream ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.journal = opts.journalDir ? new Journal(opts.journalDir) : null;
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

    let telem: { key: string; decisionId: string } | null = null;
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
        const lastMsg = Array.isArray(parsed.messages) ? (parsed.messages as Message[]).at(-1) : undefined;
        const lastText = lastMsg ? JSON.stringify(lastMsg.content).slice(0, 160) : '';
        const hdrs = Object.keys(headers).filter((h) => h.startsWith('x-') || h.startsWith('anthropic-')).join(',');
        this.opts.onNotice?.(`debug headers=${hdrs} last=${lastText}`);
        this.opts.onNotice?.(`debug ${pathname} model=${String(parsed.model)} messages=${msgs} tools=${tools} session=${headers['x-claude-code-session-id'] ?? '-'} agent=${headers['x-claude-code-agent-id'] ?? '-'} top=${JSON.stringify(parsed.output_config ?? null)} beta=${headers['anthropic-beta'] ?? ''} :: ${shape}`);
      }
      if (parsed && isJevModel(parsed.model)) {
        parsed.model = stripJevModel(parsed.model);
        if (pathname === '/v1/messages' && Array.isArray(parsed.messages) && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
          const routed = await this.route(headers, parsed);
          parsed.messages = routed.messages;
          if (routed.decisionId && routed.key) telem = { key: routed.key, decisionId: routed.decisionId };
          headers['anthropic-beta'] = addBeta(headers['anthropic-beta']);
        }
        body = Buffer.from(JSON.stringify(parsed));
      } else if (parsed && pathname === '/v1/messages' && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        // Model switches must not label the next model's responses with a stale Jev decision.
        this.display.clear(headers['x-claude-code-session-id'] ?? 'no-session', headers['x-claude-code-agent-id'] ?? 'main');
      }
    }

    // The request is on its way: mark the prepared decision as sent before dispatch.
    if (telem) this.journalAppend(telem.key, { decisionId: telem.decisionId, status: 'sent', at: Date.now() });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    let up: Response;
    try {
      up = await fetch(this.upstream + url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' || !body ? undefined : new Uint8Array(body),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      if (telem) this.journalAppend(telem.key, { decisionId: telem.decisionId, status: 'failed', at: Date.now(), error: (err as Error).message });
      throw err;
    }

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
    if (!up.body) {
      if (telem) this.journalAppend(telem.key, { decisionId: telem.decisionId, status: up.ok ? 'completed' : 'failed', at: Date.now() });
      return void res.end();
    }
    const stream = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
    if (telem) this.attachTelemetry(stream, telem, up, res, controller);
    stream.pipe(res);
  }

  /**
   * Tee a bounded copy of a routed response for usage telemetry. The stream
   * pipes to the client unchanged — listeners only observe the bytes that flow,
   * so backpressure is preserved. The final journal status is `completed` when
   * the stream ends cleanly under an OK status, `failed` on an upstream error
   * status or a stream error, and `unknown` when the client went away first
   * (acceptance unknown).
   */
  private attachTelemetry(
    stream: Readable,
    telem: { key: string; decisionId: string },
    up: Response,
    res: http.ServerResponse,
    controller: AbortController,
  ): void {
    // message_start (input/cache usage) arrives first and message_delta (final
    // output usage, stop_reason) arrives last, so keep a bounded head AND a
    // rolling tail: a long response, like a large file write, can't push the
    // final usage out of the copy.
    const head: Buffer[] = [];
    let headSize = 0;
    const tail: Buffer[] = [];
    let tailSize = 0;
    let done = false;
    const finish = (streamOk: boolean) => {
      if (done) return;
      done = true;
      const clientGone = controller.signal.aborted || (res.destroyed && !res.writableFinished);
      const status: JournalStatus = clientGone ? 'unknown' : streamOk && up.ok ? 'completed' : 'failed';
      // The tail may start mid-event; the parser skips unparseable fragments.
      const copy = tailSize ? Buffer.concat([...head, Buffer.from('\n\n'), ...tail]) : Buffer.concat(head);
      const usage = responseUsage(up.headers.get('content-type') ?? '', copy);
      this.journalAppend(telem.key, { decisionId: telem.decisionId, status, at: Date.now(), ...(usage ? { usage } : {}) });
    };
    stream.on('data', (c: Buffer) => {
      if (headSize < TELEMETRY_CAP / 2) {
        head.push(c);
        headSize += c.length;
        return;
      }
      tail.push(c);
      tailSize += c.length;
      while (tailSize > TELEMETRY_CAP / 2 && tail.length > 1) tailSize -= tail.shift()!.length;
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
    res.on('close', () => finish(false));
  }

  /**
   * Single-flight per branch: an identical request (same boundary fingerprint)
   * awaits the prepared transformation; anything else serializes on the
   * thread's queue and is decided exactly once.
   */
  private async route(headers: Record<string, string>, body: Record<string, unknown>): Promise<Routed> {
    const messages = body.messages as Message[];
    const session = headers['x-claude-code-session-id'] ?? 'no-session';
    const agent = headers['x-claude-code-agent-id'] ?? 'main';
    const hashes = prefixHashes(messages);
    const key = `${session}|${agent}|${hashes[1]?.slice(0, 16) ?? 'empty'}`;
    const t = this.thread(key, messages, hashes);

    const lastUser = lastIndexOfRole(messages, 'user');
    if (lastUser < 0) return { messages: applyInsertions(messages, validInsertions(t.insertions, messages, hashes)) };
    // Claude Code forks the conversation for side queries such as the next-prompt
    // suggestion. Replay our statements so the fork shares the cache, but don't
    // route it: it isn't a user prompt, and it must not move the status line.
    if (isSideQuery(messages[lastUser])) return { messages: applyInsertions(messages, validInsertions(t.insertions, messages, hashes)) };
    const fp = requestFingerprint(hashes[lastUser + 1]!, body);

    const hit = t.prepared.get(fp);
    if (hit) return this.replay(await hit, key, messages, hashes);

    const prepared = t.queue.then(() => this.decide(t, key, fp, lastUser, messages, hashes, body, session, agent));
    t.queue = prepared.then(
      () => undefined,
      () => undefined,
    );
    t.prepared.set(fp, prepared);
    void prepared.catch(() => {
      if (t.prepared.get(fp) === prepared) t.prepared.delete(fp);
    });
    while (t.prepared.size > PREPARED_CAP) {
      const oldest = t.prepared.keys().next().value;
      if (oldest === undefined || oldest === fp) break;
      t.prepared.delete(oldest);
    }
    return this.replay(await prepared, key, messages, hashes);
  }

  /** Apply a prepared transformation to a request's messages (retry-safe). */
  private replay(p: Prepared, key: string, messages: Message[], hashes: string[]): Routed {
    return { messages: applyInsertions(messages, validInsertions(p.insertions, messages, hashes)), decisionId: p.decisionId, key };
  }

  /**
   * Runs inside the thread's queue: restores the common-ancestor state when the
   * request branched off earlier history, decides effort, journals the prepared
   * transformation BEFORE it is forwarded upstream, and returns it.
   */
  private async decide(
    t: Thread,
    key: string,
    fp: string,
    lastUser: number,
    messages: Message[],
    hashes: string[],
    body: Record<string, unknown>,
    session: string,
    agent: string,
  ): Promise<Prepared> {
    // Keep only insertions whose prefix is still Claude Code's history (compaction or /rewind drop the rest).
    t.insertions = validInsertions(t.insertions, messages, hashes);

    // This boundary was never prepared: if the thread state reflects an
    // abandoned branch (changed history, rewind, restart), first restore the
    // state the deepest shared ancestor left behind.
    const ancestor = deepestBoundary(t.records, hashes, lastUser);
    if (ancestor !== t.tip) this.restore(t, ancestor, messages, hashes, lastUser);

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
      const rec = this.journalRecord(t, fp, lastUser, hashes, manual.effort, prompting ? 'task' : 'step', current);
      t.decidedAt = lastUser + 1;
      this.journalAppend(key, rec);
      t.records.push(rec);
      t.tip = rec;
      return { decisionId: rec.decisionId, insertions: rec.insertions };
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
    const rec = this.journalRecord(t, fp, lastUser, hashes, final.effort, decision.kind, current);
    t.decidedAt = lastUser + 1;
    this.journalAppend(key, rec);
    t.records.push(rec);
    t.tip = rec;
    return { decisionId: rec.decisionId, insertions: rec.insertions };
  }

  private journalRecord(
    t: Thread,
    fp: string,
    lastUser: number,
    hashes: string[],
    effort: Effort,
    kind: 'task' | 'step',
    current: Effort,
  ): JournalRecord {
    return {
      decisionId: randomUUID(),
      requestFingerprint: fp,
      lastUser,
      boundaryHash: hashes[lastUser + 1]!,
      insertions: t.insertions.map((i) => ({ ...i })),
      routerSnapshot: t.router.snapshot(),
      policy: POLICY_VERSION,
      requested: effort,
      current,
      kind,
      manual: t.manual,
      turn: t.turn,
      consecutiveFailures: t.consecutiveFailures,
      clientEffort: t.clientEffort,
      profile: t.profile,
      status: 'prepared',
      at: Date.now(),
    };
  }

  /**
   * Rewind thread state to a journaled decision: restore the opaque router
   * snapshot and rebuild the deterministic fields (prompt, profile, counters,
   * trajectory) from the surviving branch, without ever storing prompt text.
   */
  private restore(t: Thread, tip: JournalRecord | null, messages: Message[], hashes: string[], lastUser: number): void {
    if (tip) t.router.restore(tip.routerSnapshot);
    else t.router = new EffortRouter({ jev: this.opts.jev, bounds: this.opts.bounds });
    t.trajectory = [];
    if (tip) {
      // Replay the surviving branch's step records to rebuild the trajectory
      // Jev sees — the same lines the live path would have produced.
      for (const rec of t.records) {
        // Manual overrides are journaled but produced no live trajectory line.
        if (rec.kind !== 'step' || rec.manual || rec.lastUser > tip.lastUser) continue;
        if (rec.lastUser + 1 >= hashes.length || hashes[rec.lastUser + 1] !== rec.boundaryHash) continue;
        const { batch } = lastToolRound(messages.slice(0, rec.lastUser + 1));
        t.trajectory.push(`step ${rec.turn} @${rec.current ?? rec.requested}: ${batch.map((c) => `${c.tool} ${c.summary.slice(0, 60)} ${c.failed ? 'FAILED' : 'ok'}`).join('; ')}`);
      }
    }
    t.profile = tip?.profile ?? null;
    t.turn = tip?.turn ?? 0;
    t.consecutiveFailures = tip?.consecutiveFailures ?? 0;
    t.manual = tip?.manual ?? false;
    t.clientEffort = tip?.clientEffort ?? null;
    t.prompt = tip ? lastPrompt(messages.slice(0, tip.lastUser + 1)) : '';
    t.decidedAt = tip ? tip.lastUser + 1 : 0;
    // Effort in force at the new boundary: the last surviving statement,
    // else whatever the ancestor left in force.
    t.effort = [...t.insertions].reverse().find((i) => i.index <= lastUser)?.effort ?? tip?.requested ?? null;
    t.tip = tip;
  }

  private journalAppend(key: string, line: JournalLine): void {
    if (!this.journal) return;
    try {
      this.journal.append(key, line);
    } catch (err) {
      this.opts.onNotice?.(`journal write error: ${(err as Error).message}`);
    }
  }

  private thread(key: string, messages: Message[], hashes: string[]): Thread {
    let t = this.threads.get(key);
    if (t) {
      this.threads.delete(key); // LRU: re-insert as most recent
      this.threads.set(key, t);
      return t;
    }
    t = {
      router: new EffortRouter({ jev: this.opts.jev, bounds: this.opts.bounds }),
      insertions: [], decidedAt: 0, prompt: '', profile: null, turn: 0, consecutiveFailures: 0, trajectory: [],
      manual: false, effort: null, clientEffort: null,
      queue: Promise.resolve(), prepared: new Map(), records: [], tip: null,
    };
    // A cache miss (eviction or restart) rebuilds the thread from the durable
    // journal, so a continued conversation replays the statements sent before.
    if (this.journal) {
      try {
        t.records = this.journal.records(key);
        for (const rec of t.records) {
          t.prepared.set(rec.requestFingerprint, Promise.resolve({ decisionId: rec.decisionId, insertions: rec.insertions }));
        }
        const tip = deepestBoundary(t.records, hashes);
        if (tip) {
          t.insertions = tip.insertions.map((i) => ({ ...i }));
          this.restore(t, tip, messages, hashes, Math.max(0, lastIndexOfRole(messages, 'user')));
        }
      } catch (err) {
        this.opts.onNotice?.(`journal read error: ${(err as Error).message}`);
      }
    }
    this.threads.set(key, t);
    const max = this.opts.maxThreads ?? 256;
    while (this.threads.size > max) this.threads.delete(this.threads.keys().next().value!);
    return t;
  }

  /** effort path of the current prompt per session, shown live in the status line */
  private readonly trails = new Map<string, string[]>();

  private writeStatus(session: string, agent: string, d: EffortDecision): void {
    if (!this.opts.statusDir || agent !== 'main' || !/^[\w-]+$/.test(session)) return;
    try {
      fs.mkdirSync(this.opts.statusDir, { recursive: true });
      const phase = d.signals?.phase ?? d.profile?.taskType ?? '';
      // A new prompt starts a new path; every later change extends it.
      let trail = d.kind === 'task' ? (d.previous && d.previous !== d.effort ? [d.previous] : []) : this.trails.get(session) ?? [];
      if (trail.at(-1) !== d.effort) trail = [...trail, d.effort];
      this.trails.delete(session);
      this.trails.set(session, trail);
      while (this.trails.size > 256) this.trails.delete(this.trails.keys().next().value!);
      fs.writeFileSync(path.join(this.opts.statusDir, `${session}.json`), JSON.stringify({ effort: d.effort, previous: d.previous, trail, phase, source: d.source, at: Date.now() }));
    } catch {
      // the statusline is cosmetic
    }
  }
}

/** Claude Code's forked side queries (next-prompt suggestion) announce themselves in the appended user turn. */
const SIDE_QUERY_MARKERS = ['[SUGGESTION MODE:'];

export function isSideQuery(m: Message | undefined): boolean {
  if (!m || m.role !== 'user') return false;
  const text = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : '';
  return SIDE_QUERY_MARKERS.some((marker) => text.includes(marker));
}

/** Insertions whose stored prefix is still a prefix of this request. */
function validInsertions(insertions: readonly Insertion[], messages: readonly Message[], hashes: readonly string[]): Insertion[] {
  return insertions.filter((ins) => ins.index <= messages.length && ins.index < hashes.length && hashes[ins.index] === ins.prefixHash);
}

/**
 * Deepest journaled decision whose boundary is a prefix of this request — the
 * common ancestor for a rewind or rebuild. `beforeLastUser` restricts the
 * search to boundaries strictly above the current one (its own record is not
 * its ancestor).
 */
function deepestBoundary(records: readonly JournalRecord[], hashes: readonly string[], beforeLastUser?: number): JournalRecord | null {
  let best: JournalRecord | null = null;
  for (const r of records) {
    if (beforeLastUser !== undefined && r.lastUser >= beforeLastUser) continue;
    if (r.lastUser + 1 >= hashes.length || hashes[r.lastUser + 1] !== r.boundaryHash) continue;
    if (!best || r.lastUser >= best.lastUser) best = r;
  }
  return best;
}

/** Parse usage + stop_reason out of a bounded response copy (SSE or plain JSON). */
function responseUsage(contentType: string, buf: Buffer): JournalUsage | undefined {
  const text = buf.toString('utf8');
  if (contentType.includes('text/event-stream')) return sseUsage(text);
  if (contentType.includes('json')) return bodyUsage(text);
  return undefined;
}

function sseUsage(text: string): JournalUsage | undefined {
  const usage: JournalUsage = {};
  let found = false;
  for (const evt of text.split(/\r?\n\r?\n/)) {
    for (const line of evt.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j: { type?: string; message?: { model?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; delta?: { stop_reason?: string } };
      try {
        j = JSON.parse(data) as typeof j;
      } catch {
        continue;
      }
      if (j.type === 'message_start' && j.message) {
        found = true;
        if (typeof j.message.model === 'string') usage.model = j.message.model;
        mergeUsage(usage, j.message.usage);
      } else if (j.type === 'message_delta') {
        found = true;
        mergeUsage(usage, j.usage);
        if (typeof j.delta?.stop_reason === 'string') usage.stopReason = j.delta.stop_reason;
      }
    }
  }
  return found ? usage : undefined;
}

function bodyUsage(text: string): JournalUsage | undefined {
  try {
    const j = JSON.parse(text) as { usage?: Record<string, unknown>; stop_reason?: string; model?: string };
    const usage: JournalUsage = {};
    if (typeof j.model === 'string') usage.model = j.model;
    if (typeof j.stop_reason === 'string') usage.stopReason = j.stop_reason;
    mergeUsage(usage, j.usage);
    return Object.keys(usage).length ? usage : undefined;
  } catch {
    return undefined;
  }
}

function mergeUsage(u: JournalUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return;
  if (typeof raw.input_tokens === 'number') u.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') u.outputTokens = raw.output_tokens;
  if (typeof raw.cache_read_input_tokens === 'number') u.cacheReadInputTokens = raw.cache_read_input_tokens;
  if (typeof raw.cache_creation_input_tokens === 'number') u.cacheCreationInputTokens = raw.cache_creation_input_tokens;
}

export function readStatus(statusDir: string, session: string): { effort: Effort; previous: Effort | null; trail?: string[]; phase: string; source: string; at: number } | null {
  if (!/^[\w-]+$/.test(session)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(statusDir, `${session}.json`), 'utf8'));
  } catch {
    return null;
  }
}
