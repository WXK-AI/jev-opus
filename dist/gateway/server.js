import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EffortRouter } from '../router/router.js';
import { isEffort } from '../effort.js';
import { addBeta, applyInsertions, clientEffort, hasToolResults, isJevModel, lastIndexOfRole, lastPrompt, lastToolRound, prefixHashes, stripJevModel, userText, } from './transcript.js';
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
export class JevGateway {
    opts;
    upstream;
    threads = new Map();
    server = null;
    constructor(opts) {
        this.opts = opts;
        this.upstream = (opts.upstream ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    }
    async listen() {
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch((err) => {
                this.opts.onNotice?.(`gateway error: ${err.message}`);
                if (!res.headersSent)
                    res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `jev gateway: ${err.message}` } }));
            });
        });
        await new Promise((resolve) => this.server.listen(this.opts.port ?? 0, this.opts.host ?? '127.0.0.1', resolve));
        const a = this.server.address();
        return `http://${a.address}:${a.port}`;
    }
    async close() {
        await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    }
    async handle(req, res) {
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        let body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (v === undefined || HOP_BY_HOP.has(k))
                continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        const url = req.url ?? '/';
        const pathname = url.split('?')[0];
        if (req.method === 'POST' && body && (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens')) {
            let parsed = null;
            try {
                parsed = JSON.parse(body.toString('utf8'));
            }
            catch {
                parsed = null; // not JSON: pass through untouched
            }
            if (parsed && process.env.JEV_GATEWAY_DEBUG === '1') {
                const msgs = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
                const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
                const shape = Array.isArray(parsed.messages)
                    ? parsed.messages.map((m) => `${m.role}${m.output_config ? `{${JSON.stringify(m.output_config)}}` : ''}[${Array.isArray(m.content) ? m.content.map((b) => b.type).join('+') : typeof m.content}]`).join(' ')
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
            }
        }
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableFinished)
            controller.abort(); });
        const up = await fetch(this.upstream + url, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' || !body ? undefined : new Uint8Array(body),
            signal: controller.signal,
            redirect: 'manual',
        });
        const outHeaders = {};
        up.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k))
            outHeaders[k] = v; });
        if (pathname === '/v1/models' && req.method === 'GET' && up.ok) {
            const data = (await up.json());
            if (Array.isArray(data.data)) {
                data.data.unshift({ id: 'jev/claude-opus-5-5', display_name: 'Opus 5.5 · Jev', description: 'Opus 5.5 with effort re-picked every step by Jev', type: 'model' });
            }
            res.writeHead(up.status, { ...outHeaders, 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
        }
        res.writeHead(up.status, outHeaders);
        if (!up.body)
            return void res.end();
        Readable.fromWeb(up.body).pipe(res);
    }
    /** Decide effort for this request and return the messages with all insertions replayed. */
    async route(headers, body) {
        const messages = body.messages;
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
        if (lastUser < 0 || lastUser < t.decidedAt)
            return applyInsertions(messages, t.insertions); // retry: replay only
        t.decidedAt = lastUser + 1;
        const last = messages[lastUser];
        const prompting = !hasToolResults(last) && userText(last).length > 0;
        // Claude Code states its own /effort level as a per-turn statement. A *change* in that value is the user
        // choosing a level by hand: honor it for the rest of this prompt.
        const client = clientEffort(messages);
        const topLevel = body.output_config?.effort;
        if (client && t.clientEffort !== null && client.effort !== t.clientEffort)
            t.manual = true;
        else if (prompting)
            t.manual = false;
        if (client)
            t.clientEffort = client.effort;
        const current = t.effort ?? client?.effort ?? (isEffort(topLevel) ? topLevel : 'medium');
        if (t.manual) {
            t.effort = client?.effort ?? current;
            return applyInsertions(messages, t.insertions);
        }
        let decision;
        if (prompting || !t.profile) {
            t.prompt = prompting ? userText(last) : lastPrompt(messages);
            t.turn = 0;
            t.consecutiveFailures = 0;
            t.trajectory = [];
            decision = await t.router.routeTask(t.prompt || '(continuing an earlier task)', current);
            t.profile = decision.profile ?? t.router.lastProfileFallback(t.prompt);
        }
        else {
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
            t.insertions.push({ index: lastUser, effort: decision.effort, prefixHash: hashes[lastUser] });
            if (clientChoseThisTurn)
                t.insertions.push({ index: messages.length, effort: decision.effort, prefixHash: hashes[messages.length] });
        }
        t.effort = decision.effort;
        const final = { ...decision, previous: current, changed: decision.effort !== current };
        this.opts.onDecision?.(session, final);
        this.opts.trace?.({ event: 'gateway_decision', session, agent, index: lastUser, ...final });
        this.writeStatus(session, agent, final);
        return applyInsertions(messages, t.insertions);
    }
    thread(key) {
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
        while (this.threads.size > max)
            this.threads.delete(this.threads.keys().next().value);
        return t;
    }
    writeStatus(session, agent, d) {
        if (!this.opts.statusDir || agent !== 'main' || !/^[\w-]+$/.test(session))
            return;
        try {
            fs.mkdirSync(this.opts.statusDir, { recursive: true });
            const phase = d.signals?.phase ?? d.profile?.taskType ?? '';
            fs.writeFileSync(path.join(this.opts.statusDir, `${session}.json`), JSON.stringify({ effort: d.effort, previous: d.previous, phase, source: d.source, at: Date.now() }));
        }
        catch {
            // the statusline is cosmetic
        }
    }
}
export function readStatus(statusDir, session) {
    if (!/^[\w-]+$/.test(session))
        return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(statusDir, `${session}.json`), 'utf8'));
    }
    catch {
        return null;
    }
}
