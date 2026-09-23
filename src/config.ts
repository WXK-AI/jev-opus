import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEffort, type Effort } from './effort.ts';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.JEV_OPUS_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'jev-opus');
export const CONFIG_ENV_FILE = path.join(CONFIG_DIR, '.env');

// Values already in the environment win; then a repo-clone .env; then the user config file.
for (const file of [path.join(PROJECT_ROOT, '.env'), CONFIG_ENV_FILE]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // missing file — fine, `doctor` reports anything required that is unset
  }
}

function envEffort(name: string, fallback: Effort): Effort {
  const v = process.env[name];
  return isEffort(v) ? v : fallback;
}

export const config = {
  model: process.env.JEV_OPUS_MODEL || 'claude-opus-5-5',
  claudePath: process.env.JEV_OPUS_CLAUDE_PATH || undefined,
  minEffort: envEffort('JEV_OPUS_MIN_EFFORT', 'low'),
  maxEffort: envEffort('JEV_OPUS_MAX_EFFORT', 'high'),
  traceDir: process.env.JEV_OPUS_TRACE_DIR || path.join(CONFIG_DIR, 'traces'),
  jev: {
    // Jev directly from TypeSafe, or through OpenRouter (same answers, pay with OpenRouter credits).
    provider: (process.env.JEV_PROVIDER || (!process.env.JEV_API_KEY && process.env.OPENROUTER_API_KEY ? 'openrouter' : 'typesafe')) as 'typesafe' | 'openrouter',
    apiKey: process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '',
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.JEV_BASE_URL || 'https://api.typesafe.ai/v1/systemone',
    model: process.env.JEV_MODEL || 'jev-latest',
    openrouterUrl: process.env.JEV_OPENROUTER_URL || 'https://openrouter.ai/api/alpha/decisions',
    openrouterModel: process.env.JEV_OPENROUTER_MODEL || 'typesafe/jev-1.13',
    timeoutMs: 8_000,
    retries: 1,
    inputPricePerMillion: 0.042,
  },
  /**
   * Credentials handed to the Claude Code child process. Only what is set in
   * the jev-opus config or the launching shell — never the variables a
   * parent Claude Code / desktop session injected.
   */
  claudeCredentials: {
    apiKey: process.env.JEV_OPUS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    oauthToken: process.env.JEV_OPUS_CLAUDE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    authToken: process.env.JEV_OPUS_ANTHROPIC_AUTH_TOKEN || '',
    baseUrl: process.env.JEV_OPUS_ANTHROPIC_BASE_URL || '',
  },
};
