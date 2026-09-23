import { config } from '../config.ts';

/**
 * Environment for the Claude Code child process.
 *
 * A parent Claude Code session (CLI or desktop app) exports its own
 * ANTHROPIC_* / CLAUDE_* variables — its auth token, model aliases, and
 * CLAUDE_CODE_EFFORT_LEVEL, which would override every effort change we make.
 * None of that is ours to reuse, so it is all stripped and replaced with the
 * credential in the jev-opus config (~/.config/jev-opus/.env), or else the `claude` login.
 */
const INHERITED = /^(ANTHROPIC_|CLAUDE|MCP_|OTEL_)/;
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);

export interface ChildEnv {
  env: Record<string, string>;
  credential: string;
}

export function childEnv(base: NodeJS.ProcessEnv = process.env, opts: { connectors?: boolean } = {}): ChildEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (INHERITED.test(k) && !KEEP.has(k)) continue;
    env[k] = v;
  }

  const c = config.claudeCredentials;
  let credential = 'claude login (run `claude auth login` once)';
  if (c.apiKey) {
    env.ANTHROPIC_API_KEY = c.apiKey;
    credential = 'ANTHROPIC_API_KEY from jev-opus config';
  } else if (c.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken;
    credential = 'CLAUDE_CODE_OAUTH_TOKEN from jev-opus config';
  } else if (c.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = c.authToken;
    credential = 'JEV_OPUS_ANTHROPIC_AUTH_TOKEN from jev-opus config';
  }
  if (c.baseUrl) env.ANTHROPIC_BASE_URL = c.baseUrl;
  // claude.ai connectors (Gmail, Drive, …) are noise for a delegated coding task; opt back in with JEV_OPUS_CLAUDEAI_CONNECTORS=1.
  if (!opts.connectors && base.JEV_OPUS_CLAUDEAI_CONNECTORS !== '1') env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return { env, credential };
}
