export function displayMode(value = process.env.JEV_OPUS_DISPLAY) {
    return value === 'changes' || value === 'off' ? value : 'every-response';
}
/** Plain-language labels for the policy's internal reason strings, most important first. */
const REASON_LABELS = [
    [/failing check now passes/, 'matching checks passed'],
    [/failed step|same failure|failing checks/, 'failing checks'],
    [/stuck/, 'stuck, escalating'],
    [/environment blocker/, 'environment issue, holding'],
    [/unresolved issue/, 'unresolved failure, holding'],
    [/bounded to/, 'at your effort limit'],
    [/holding|→ hold|release hold/, 'holding after escalation'],
    [/hard step/, 'hard next step'],
    [/high stakes/, 'high stakes'],
    [/trivial step/, 'routine step'],
];
export function formatEffortBadge(d, showChange = true) {
    const change = showChange && d.previous && d.previous !== d.effort ? `${d.previous.toUpperCase()} → ` : '';
    const phase = (d.signals?.phase ?? d.profile?.taskType ?? '').replaceAll('_', ' ');
    const label = d.source === 'pinned' ? 'manual override'
        : d.kind === 'task' && d.profile ? d.profile.taskType.replaceAll('_', ' ')
            : REASON_LABELS.find(([re]) => d.reasons.some((r) => re.test(r)))?.[1] ?? phase;
    const source = d.source === 'heuristic' ? ' · local routing' : '';
    return `◆ Jev · ${change}${d.effort.toUpperCase()}${label ? ` · ${label}` : ''}${source}`;
}
/** Retrospective path, never presented as the effort for one response. */
export function formatEffortTrail(trail, d) {
    return `◆ Jev · path ${trail.map((e) => e.toUpperCase()).join(' → ')} · now ${d.effort.toUpperCase()}`;
}
/** Visual-only annotations. Text-hook association is explicitly inferred, tool IDs are exact. */
export class EffortDisplay {
    entries = new Map();
    attempts = new Map();
    tools = new Map();
    messages = new Map();
    maxEntries;
    mode;
    showDecisionIds;
    onAnnotation;
    constructor(maxEntries = 256, mode = 'every-response', onAnnotation, showDecisionIds = process.env.JEV_OPUS_SHOW_DECISION_IDS === '1') {
        this.maxEntries = maxEntries;
        this.mode = mode;
        this.showDecisionIds = showDecisionIds;
        this.onAnnotation = onAnnotation;
    }
    record(session, agent, decision, context) {
        const key = JSON.stringify([session, agent]);
        const prior = this.entries.get(key);
        if (context?.attemptId && prior?.context?.attemptId === context.attemptId)
            return;
        const entry = { decision, context, noticed: false, announce: decision.kind === 'task' || decision.changed };
        this.set(this.entries, key, entry);
        if (context?.attemptId)
            this.set(this.attempts, JSON.stringify([session, agent, context.attemptId]), entry);
    }
    bindTool(session, agent, id, decision, context) {
        const current = this.attempts.get(JSON.stringify([session, agent, context.attemptId]));
        const entry = current?.context?.attemptId === context.attemptId ? current : { decision, context, noticed: false, announce: true };
        this.set(this.tools, JSON.stringify([session, agent, id]), entry);
    }
    markText(session, agent, context) {
        const entry = this.attempts.get(JSON.stringify([session, agent, context.attemptId]));
        if (entry)
            entry.hasText = true;
    }
    clear(session, agent) {
        this.entries.delete(JSON.stringify([session, agent]));
        for (const map of [this.tools, this.messages, this.attempts])
            for (const key of map.keys()) {
                const ids = JSON.parse(key);
                if (ids[0] === session && ids[1] === agent)
                    map.delete(key);
            }
    }
    set(map, key, value) {
        map.delete(key);
        map.set(key, value);
        while (map.size > this.maxEntries * 8)
            map.delete(map.keys().next().value);
    }
    handle(input) {
        if (this.mode === 'off' || !input || typeof input !== 'object' || Array.isArray(input))
            return {};
        const i = input;
        if (typeof i.session_id !== 'string' || (i.agent_id !== undefined && typeof i.agent_id !== 'string'))
            return {};
        const session = i.session_id, agent = i.agent_id ?? 'main';
        const tool = typeof i.tool_use_id === 'string' ? this.tools.get(JSON.stringify([session, agent, i.tool_use_id])) : undefined;
        const entry = tool ?? this.entries.get(JSON.stringify([session, agent]));
        if (!entry)
            return {};
        const textHook = i.hook_event_name === 'MessageDisplay';
        if (textHook && (i.index !== 0 || typeof i.delta !== 'string' || !i.delta))
            return {};
        if (!textHook && i.hook_event_name !== 'PreToolUse')
            return {};
        const messageKey = textHook && typeof i.message_id === 'string'
            ? JSON.stringify([session, agent, i.turn_id, i.message_id]) : undefined;
        const cached = messageKey ? this.messages.get(messageKey) : undefined;
        if (cached !== undefined)
            return cached ? { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: `> **${cached}**\n\n${i.delta}` } } : {};
        const show = textHook ? this.mode === 'every-response' || entry.announce
            : !entry.noticed && !entry.hasText && (this.mode === 'every-response' || entry.announce);
        if (!show) {
            if (messageKey)
                this.set(this.messages, messageKey, '');
            return {};
        }
        const badge = formatEffortBadge(entry.decision, entry.announce) + (this.showDecisionIds && entry.context ? ` · D-${entry.context.decisionId.slice(0, 8)}` : '');
        if (messageKey)
            this.set(this.messages, messageKey, badge);
        entry.announce = false;
        entry.noticed = true;
        if (entry.context) {
            const id = (v) => typeof v === 'string' ? v.slice(0, 200) : undefined;
            this.onAnnotation?.(entry.context.key, {
                event: 'annotation_returned', decisionId: entry.context.decisionId, attemptId: entry.context.attemptId,
                at: Date.now(), badge, hook: String(i.hook_event_name),
                messageId: id(i.message_id), turnId: id(i.turn_id), toolUseId: id(i.tool_use_id),
                association: tool ? 'tool-id' : 'session-latest',
            });
        }
        return textHook
            ? { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: `> **${badge}**\n\n${i.delta}` } }
            : { systemMessage: badge };
    }
}
/** Hook metadata stays out of the conversation and never changes tool permissions. */
export function inlineEffortSettings(hookUrl, opts = {}) {
    const hook = [{ hooks: [{ type: 'http', url: hookUrl, timeout: 1 }] }];
    return { hooks: opts.toolNotices !== false ? { MessageDisplay: hook, PreToolUse: hook } : { MessageDisplay: hook } };
}
