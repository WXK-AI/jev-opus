import type { Settings, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { EffortDecision } from '../router/types.ts';

export function formatEffortBadge(d: EffortDecision, showChange = true): string {
  const change = showChange && d.previous && d.previous !== d.effort ? `${d.previous.toUpperCase()} → ` : '';
  const phase = d.source === 'pinned' ? 'manual override' : (d.signals?.phase ?? d.profile?.taskType ?? '').replaceAll('_', ' ');
  const source = d.source === 'heuristic' ? ' · local routing' : '';
  return `◆ Jev · ${change}${d.effort.toUpperCase()}${phase ? ` · ${phase}` : ''}${source}`;
}

/** "LOW → MEDIUM → HIGH": every level since the last badge, oldest first. */
export function formatEffortTrail(trail: readonly string[], d: EffortDecision): string {
  const path = trail.map((e) => e.toUpperCase()).join(' → ') || d.effort.toUpperCase();
  const phase = d.source === 'pinned' ? 'manual override' : (d.signals?.phase ?? d.profile?.taskType ?? '').replaceAll('_', ' ');
  return `◆ Jev · ${path}${phase ? ` · ${phase}` : ''}`;
}

interface Entry {
  decision: EffortDecision;
  /** levels in force since the last badge was shown, deduplicated in order */
  trail: string[];
  /** a tool notice was already emitted for the latest decision */
  noticed: boolean;
}

/**
 * UI state only. No hook output is added to Claude's model conversation.
 *
 * Effort usually changes during tool-only steps, where Claude writes no text.
 * Rather than a notice per change, the next text badge shows the whole path
 * since the previous badge (for example LOW → MEDIUM → HIGH), and the status
 * line shows the live level. Per-tool notices are opt-in.
 */
export class EffortDisplay {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  record(session: string, agent: string, decision: EffortDecision): void {
    const key = JSON.stringify([session, agent]);
    const prior = this.entries.get(key);
    const trail = prior ? [...prior.trail] : decision.previous ? [decision.previous] : [];
    if (trail.at(-1) !== decision.effort) trail.push(decision.effort);
    this.entries.delete(key);
    this.entries.set(key, { decision, trail, noticed: false });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(session: string, agent: string): void {
    this.entries.delete(JSON.stringify([session, agent]));
  }

  handle(input: unknown): SyncHookJSONOutput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const i = input as Record<string, unknown>;
    if (typeof i.session_id !== 'string' || (i.agent_id !== undefined && typeof i.agent_id !== 'string')) return {};
    const key = JSON.stringify([i.session_id, i.agent_id ?? 'main']);
    const entry = this.entries.get(key);
    if (!entry) return {};

    if (i.hook_event_name === 'MessageDisplay') {
      // Each message can stream many deltas. Prefix only its first delta;
      // all subsequent text passes through exactly as Claude produced it.
      if (i.index !== 0 || typeof i.delta !== 'string' || !i.delta) return {};
      const badge = formatEffortTrail(entry.trail, entry.decision);
      entry.trail = [entry.decision.effort]; // the next badge starts from the level now in force
      entry.noticed = true; // this badge announced the change; no tool notice repeats it
      return { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: `> **${badge}**\n\n${i.delta}` } };
    }

    if (i.hook_event_name === 'PreToolUse' && !entry.noticed && entry.decision.changed) {
      // Only registered when JEV_OPUS_TOOL_NOTICES=1: one native notice per change.
      entry.noticed = true;
      return { systemMessage: formatEffortBadge(entry.decision) };
    }
    return {};
  }
}

/** Local HTTP hooks avoid spawning a Node process for every streamed text delta. */
export function inlineEffortSettings(hookUrl: string, opts: { toolNotices?: boolean } = {}): Pick<Settings, 'hooks'> {
  const hook = [{ hooks: [{ type: 'http' as const, url: hookUrl, timeout: 1 }] }];
  return { hooks: opts.toolNotices ? { MessageDisplay: hook, PreToolUse: hook } : { MessageDisplay: hook } };
}
