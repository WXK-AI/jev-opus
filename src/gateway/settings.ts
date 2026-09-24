import fs from 'node:fs';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';

/** Add session-only UI settings while retaining caller-supplied settings and hooks. */
export function withGatewaySettings(args: readonly string[], additions: Pick<Settings, 'hooks' | 'statusLine'>): string[] {
  if (!additions.hooks && !additions.statusLine) return [...args];
  const out = [...args];
  let index = -1;
  let inline = false;
  for (let i = 0; i < out.length && out[i] !== '--'; i++) {
    if (out[i] === '--settings') {
      if (!out[i + 1]) throw new Error('--settings needs a JSON object or settings file');
      index = i;
      inline = false;
      i++;
    } else if (out[i]!.startsWith('--settings=')) {
      index = i;
      inline = true;
    }
  }

  let settings: Settings = {};
  if (index >= 0) {
    const value = inline ? out[index]!.slice('--settings='.length) : out[index + 1]!;
    let raw = value;
    if (!value.trimStart().startsWith('{')) {
      const stat = fs.statSync(value);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('--settings must be a regular JSON file no larger than 2 MiB');
      raw = fs.readFileSync(value, 'utf8');
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--settings must contain a JSON object');
    settings = parsed as Settings;
  }

  if (additions.statusLine && !settings.statusLine) settings.statusLine = additions.statusLine;
  if (additions.hooks) {
    settings.hooks = { ...settings.hooks };
    for (const [event, handlers] of Object.entries(additions.hooks)) {
      const existing = settings.hooks[event] ?? [];
      if (!Array.isArray(existing)) throw new Error(`--settings hooks.${event} must be an array`);
      settings.hooks[event] = [...existing, ...handlers];
    }
  }
  const json = JSON.stringify(settings);
  if (index < 0) out.unshift('--settings', json);
  else if (inline) out[index] = `--settings=${json}`;
  else out[index + 1] = json;
  return out;
}

/**
 * Effort changes mostly happen on tool-only steps, where Claude writes no text
 * and so no clean badge can render. One short line before each tool call gives
 * every step a message for the badge to sit on, and doubles as a readable
 * progress narration. It's short so Opus 5.5 keeps it as visible text, not a
 * progress-update thinking block.
 */
export const NARRATION_PROMPT =
  'Before each tool call, write one short sentence (under 15 words) saying what you are about to do. Keep it to a single line.';

/** Append the narration instruction to the caller's --append-system-prompt, or add one. */
export function withNarration(args: readonly string[], prompt = NARRATION_PROMPT): string[] {
  const out = [...args];
  for (let i = 0; i < out.length && out[i] !== '--'; i++) {
    if (out[i] === '--append-system-prompt' && out[i + 1] !== undefined) {
      out[i + 1] = `${out[i + 1]}\n\n${prompt}`;
      return out;
    }
    if (out[i]!.startsWith('--append-system-prompt=')) {
      out[i] = `${out[i]}\n\n${prompt}`;
      return out;
    }
  }
  return ['--append-system-prompt', prompt, ...out];
}
