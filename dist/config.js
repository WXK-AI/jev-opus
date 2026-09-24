import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isEffort } from './effort.js';
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.JEV_OPUS_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'jev-opus');
export const CONFIG_ENV_FILE = path.join(CONFIG_DIR, '.env');
/**
 * Variables written in jev-opus .env files, kept separate from the inherited
 * environment. A parent Claude Code session exports its own ANTHROPIC_* /
 * CLAUDE_* keys; without provenance those would be indistinguishable from
 * credentials the user configured for the child.
 *
 * Precedence matches the old `process.loadEnvFile` loop: values already in the
 * environment win, then the repo-clone .env, then the user config file.
 */
export const envFileVars = new Map();
for (const file of [path.join(PROJECT_ROOT, '.env'), CONFIG_ENV_FILE]) {
    let parsed;
    try {
        parsed = parseEnv(readFileSync(file, 'utf8'));
    }
    catch {
        continue; // missing file — fine, `doctor` reports anything required that is unset
    }
    for (const [k, v] of Object.entries(parsed)) {
        if (v === undefined)
            continue;
        // An empty line (`ANTHROPIC_API_KEY=`) doesn't count as configured, so it can't shadow a later file's value.
        if (v !== '' && !envFileVars.has(k))
            envFileVars.set(k, { value: v, file });
        if (process.env[k] === undefined)
            process.env[k] = v;
    }
}
function envEffort(name, fallback) {
    const v = process.env[name];
    return isEffort(v) ? v : fallback;
}
function envInt(name, fallback, min = 0) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
}
const noCredential = () => ({ value: '', source: '' });
/**
 * The credential handed to the Claude Code child process. Only JEV_OPUS_*
 * variables and values written in a jev-opus .env file are used. A plain
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN found in the environment may
 * have been injected by a parent Claude session — `childEnv` strips it, so
 * using it here would silently reintroduce exactly what was removed. It is
 * honored only when `inherit` (JEV_OPUS_INHERIT_CREDENTIALS=1).
 */
export function resolveClaudeCredentials(env, fileVars, opts = {}) {
    const pick = (jevName, plainName) => {
        const direct = env[jevName];
        if (direct)
            return { value: direct, source: jevName };
        if (plainName) {
            const fromFile = fileVars.get(plainName);
            if (fromFile?.value)
                return { value: fromFile.value, source: fromFile.file };
            const inherited = env[plainName];
            if (inherited && opts.inherit) {
                return { value: inherited, source: `inherited environment (JEV_OPUS_INHERIT_CREDENTIALS=1)` };
            }
        }
        return noCredential();
    };
    return {
        apiKey: pick('JEV_OPUS_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'),
        oauthToken: pick('JEV_OPUS_CLAUDE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'),
        authToken: pick('JEV_OPUS_ANTHROPIC_AUTH_TOKEN'),
        baseUrl: pick('JEV_OPUS_ANTHROPIC_BASE_URL'),
    };
}
export const config = {
    model: process.env.JEV_OPUS_MODEL || 'claude-opus-5-5',
    claudePath: process.env.JEV_OPUS_CLAUDE_PATH || undefined,
    minEffort: envEffort('JEV_OPUS_MIN_EFFORT', 'low'),
    maxEffort: envEffort('JEV_OPUS_MAX_EFFORT', 'high'),
    traceDir: process.env.JEV_OPUS_TRACE_DIR || path.join(CONFIG_DIR, 'traces'),
    jev: {
        // Jev directly from TypeSafe, or through OpenRouter (same answers, pay with OpenRouter credits).
        provider: (process.env.JEV_PROVIDER || (!process.env.JEV_API_KEY && process.env.OPENROUTER_API_KEY ? 'openrouter' : 'typesafe')),
        apiKey: process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '',
        openrouterKey: process.env.OPENROUTER_API_KEY || '',
        baseUrl: process.env.JEV_BASE_URL || 'https://api.typesafe.ai/v1/systemone',
        model: process.env.JEV_MODEL || 'jev-latest',
        openrouterUrl: process.env.JEV_OPENROUTER_URL || 'https://openrouter.ai/api/alpha/decisions',
        openrouterModel: process.env.JEV_OPENROUTER_MODEL || 'typesafe/jev-1.13',
        // One overall deadline per decision — Jev sits in the request path, so the
        // budget is small; retries (opt-in) must still finish inside it.
        deadlineMs: envInt('JEV_DEADLINE_MS', 2_500), // slowest live Jev answer observed so far: ~1.6s
        retries: envInt('JEV_RETRIES', 0),
        breakerThreshold: envInt('JEV_BREAKER_THRESHOLD', 3, 1),
        breakerCooldownMs: envInt('JEV_BREAKER_COOLDOWN_MS', 30_000),
        inputPricePerMillion: 0.042,
    },
    claudeCredentials: resolveClaudeCredentials(process.env, envFileVars, {
        inherit: process.env.JEV_OPUS_INHERIT_CREDENTIALS === '1',
    }),
};
