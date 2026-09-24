import { config } from '../config.js';
/**
 * Environment for the Claude Code child process.
 *
 * A parent Claude Code session (CLI or desktop app) exports its own
 * ANTHROPIC_* / CLAUDE_* variables — its auth token, model aliases, and
 * CLAUDE_CODE_EFFORT_LEVEL, which would override every effort change we make.
 * None of that is ours to reuse, so it is all stripped and replaced with the
 * credential in the jev-opus config (~/.config/jev-opus/.env), or else the `claude` login.
 * `config.claudeCredentials` keeps provenance, so an inherited parent key is
 * never reintroduced unless JEV_OPUS_INHERIT_CREDENTIALS=1 — and the
 * `credential` label says which source won.
 */
const INHERITED = /^(ANTHROPIC_|CLAUDE|MCP_|OTEL_)/;
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);
export function childEnv(base = process.env, opts = {}) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
        if (v === undefined)
            continue;
        if (INHERITED.test(k) && !KEEP.has(k))
            continue;
        env[k] = v;
    }
    const c = opts.credentials ?? config.claudeCredentials;
    let credential = 'claude login (run `claude auth login` once)';
    if (c.apiKey.value) {
        env.ANTHROPIC_API_KEY = c.apiKey.value;
        credential = `ANTHROPIC_API_KEY from ${c.apiKey.source}`;
    }
    else if (c.oauthToken.value) {
        env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken.value;
        credential = `CLAUDE_CODE_OAUTH_TOKEN from ${c.oauthToken.source}`;
    }
    else if (c.authToken.value) {
        env.ANTHROPIC_AUTH_TOKEN = c.authToken.value;
        credential = `ANTHROPIC_AUTH_TOKEN from ${c.authToken.source}`;
    }
    if (c.baseUrl.value)
        env.ANTHROPIC_BASE_URL = c.baseUrl.value;
    // claude.ai connectors (Gmail, Drive, …) are noise for a delegated coding task; opt back in with JEV_OPUS_CLAUDEAI_CONNECTORS=1.
    if (!opts.connectors && base.JEV_OPUS_CLAUDEAI_CONNECTORS !== '1')
        env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    return { env, credential };
}
