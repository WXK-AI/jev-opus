import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../claude/env.js';
import { CONFIG_DIR, config } from '../config.js';
import { formatDecision } from '../ui.js';
import { JevGateway, readStatus } from './server.js';
import { inlineEffortSettings } from './display.js';
import { withGatewaySettings } from './settings.js';
export const JEV_MODEL_ID = 'jev/claude-opus-5-5';
export const STATUS_DIR = path.join(CONFIG_DIR, 'status');
export const GATEWAY_LOG = path.join(CONFIG_DIR, 'gateway.log');
export const JOURNAL_DIR = path.join(CONFIG_DIR, 'journal');
/** Env that makes Claude Code route through the gateway and list "Opus 5.5 · Jev" in /model. */
export function gatewayClientEnv(baseUrl) {
    return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_CUSTOM_MODEL_OPTION: JEV_MODEL_ID,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Opus 5.5 · Jev',
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Opus 5.5 with effort re-picked every step by Jev (low/medium/high), cache-safe',
    };
}
function appendLog(line) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.appendFileSync(GATEWAY_LOG, `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
    }
    catch {
        // logging is best-effort
    }
}
export function createGateway(jev, bounds, opts = {}) {
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
            if (opts.echo)
                console.log(line);
        },
        onNotice: (m) => {
            appendLog(`! ${m}`);
            if (opts.echo)
                console.log(`! ${m}`);
        },
    });
}
/** `jev-opus claude [claude args…]`: gateway in-process + the normal interactive Claude Code on top of it. */
export async function launchClaude(jev, bounds, claudeArgs, trace) {
    const gateway = createGateway(jev, bounds, { trace });
    const baseUrl = await gateway.listen();
    const { env } = childEnv(process.env, { connectors: true });
    Object.assign(env, gatewayClientEnv(baseUrl));
    try {
        const cli = fileURLToPath(new URL('../cli.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'), import.meta.url));
        const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
        const command = `${quote(process.execPath)} ${quote(cli)} statusline`;
        const args = withGatewaySettings(claudeArgs, {
            ...(process.env.JEV_OPUS_NO_INLINE_EFFORT === '1' ? {} : inlineEffortSettings(baseUrl + gateway.displayHookPath)),
            ...(process.env.JEV_OPUS_NO_STATUSLINE === '1' ? {} : { statusLine: { type: 'command', command } }),
        });
        if (!args.some((a) => a === '--model' || a.startsWith('--model=')))
            args.unshift('--model', JEV_MODEL_ID);
        const child = spawn(config.claudePath ?? 'claude', args, { stdio: 'inherit', env });
        return await new Promise((resolve) => {
            child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
            child.on('error', (err) => {
                console.error(`could not start claude: ${err.message}`);
                resolve(127);
            });
        });
    }
    finally {
        await gateway.close();
    }
}
/** Claude Code statusLine command: shows the effort Jev picked for this session. */
export async function statusline() {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    let session = '';
    let model = '';
    try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        session = input.session_id ?? '';
        model = input.model?.display_name ?? input.model?.id ?? '';
    }
    catch {
        // no input: still print something useful
    }
    const s = session ? readStatus(STATUS_DIR, session) : null;
    if (!s)
        return void process.stdout.write(`◆ Jev ${model.includes('Jev') ? 'waiting for first step' : 'off (pick "Opus 5.5 · Jev" in /model)'}`);
    const arrow = s.previous && s.previous !== s.effort ? `${s.previous} → ` : '';
    process.stdout.write(`◆ Jev ${arrow}${s.effort.toUpperCase()}${s.phase ? ` · ${s.phase}` : ''}${s.source === 'heuristic' ? ' (heuristic)' : ''}`);
}
