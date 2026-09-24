export function formatEffortBadge(d, showChange = true) {
    const change = showChange && d.previous && d.previous !== d.effort ? `${d.previous.toUpperCase()} → ` : '';
    const phase = d.source === 'pinned' ? 'manual override' : (d.signals?.phase ?? d.profile?.taskType ?? '').replaceAll('_', ' ');
    const source = d.source === 'heuristic' ? ' · local routing' : '';
    return `◆ Jev · ${change}${d.effort.toUpperCase()}${phase ? ` · ${phase}` : ''}${source}`;
}
/** UI state only. No hook output is added to Claude's model conversation. */
export class EffortDisplay {
    decisions = new Map();
    maxEntries;
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
    }
    record(session, agent, decision) {
        const key = JSON.stringify([session, agent]);
        this.decisions.delete(key);
        this.decisions.set(key, { decision, shown: false });
        while (this.decisions.size > this.maxEntries)
            this.decisions.delete(this.decisions.keys().next().value);
    }
    clear(session, agent) {
        this.decisions.delete(JSON.stringify([session, agent]));
    }
    handle(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            return {};
        const i = input;
        if (typeof i.session_id !== 'string' || (i.agent_id !== undefined && typeof i.agent_id !== 'string'))
            return {};
        const key = JSON.stringify([i.session_id, i.agent_id ?? 'main']);
        const entry = this.decisions.get(key);
        if (!entry)
            return {};
        if (i.hook_event_name === 'MessageDisplay') {
            // Each message can stream many deltas. Prefix only its first delta;
            // all subsequent text passes through exactly as Claude produced it.
            if (i.index !== 0 || typeof i.delta !== 'string' || !i.delta)
                return {};
            const badge = formatEffortBadge(entry.decision, !entry.shown);
            entry.shown = true;
            return { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: `> **${badge}**\n\n${i.delta}` } };
        }
        if (i.hook_event_name === 'PreToolUse' && !entry.shown) {
            // Tool-only responses don't fire MessageDisplay. Show one native notice
            // for the whole decision, including when tools execute in parallel.
            entry.shown = true;
            return { systemMessage: formatEffortBadge(entry.decision) };
        }
        return {};
    }
}
/** Local HTTP hooks avoid spawning a Node process for every streamed text delta. */
export function inlineEffortSettings(hookUrl) {
    return {
        hooks: {
            MessageDisplay: [{ hooks: [{ type: 'http', url: hookUrl, timeout: 1 }] }],
            PreToolUse: [{ hooks: [{ type: 'http', url: hookUrl, timeout: 1 }] }],
        },
    };
}
