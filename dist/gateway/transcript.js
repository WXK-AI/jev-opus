import { createHash } from 'node:crypto';
import { isEffort } from '../effort.js';
import { describeToolInput, looksFailed, stringifyResult, testRunner } from '../claude/describe.js';
/**
 * Pure helpers for rewriting Claude Code's /v1/messages requests.
 *
 * Effort changes are inserted as effort-only system messages
 * (`{role: "system", content: [], output_config: {effort}}`, beta
 * `mid-conversation-output-config-2026-07-01`). Claude Code resends the whole
 * history on every request, so every insertion made so far is replayed at the
 * same position each time. The prefix the model saw stays identical, which
 * keeps both the prompt cache and preserved-thinking blocks valid.
 */
export const JEV_MODEL_PREFIX = 'jev/';
export const PER_MESSAGE_EFFORT_BETAS = ['mid-conversation-output-config-2026-07-01', 'per-turn-control-2026-07-01', 'mid-conversation-effort-2026-08-01'];
export function isJevModel(model) {
    return typeof model === 'string' && model.startsWith(JEV_MODEL_PREFIX);
}
export function stripJevModel(model) {
    return model.slice(JEV_MODEL_PREFIX.length);
}
/**
 * Canonical form for prefix comparison: Claude Code moves `cache_control`
 * breakpoints between requests and may resend string content as a text-block
 * array (or back). The API renders both identically, so neither counts as a change.
 *
 * `cache_control` is stripped only on content blocks — objects sitting inside a
 * `content` array (text/image/tool_result/tool_use/document/…). Tool arguments
 * (`tool_use.input`, and anything nested below it) are compared verbatim: a key
 * named `cache_control` there is real input, not a breakpoint hint.
 */
export function canonical(value) {
    return canonicalValue(value, false, false);
}
function canonicalValue(value, asBlock, inArgs) {
    if (Array.isArray(value))
        return value.map((v) => canonicalValue(v, false, inArgs));
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (!inArgs && asBlock && k === 'cache_control')
            continue;
        if (!inArgs && k === 'content' && typeof v === 'string') {
            out[k] = [{ type: 'text', text: v }];
        }
        else if (!inArgs && k === 'content' && Array.isArray(v)) {
            out[k] = v.map((b) => canonicalValue(b, true, false));
        }
        else if (asBlock && k === 'input') {
            out[k] = canonicalValue(v, false, true);
        }
        else {
            out[k] = canonicalValue(v, false, inArgs);
        }
    }
    return out;
}
/** prefixHashes[i] = hash of canonical messages[0..i); length = messages.length + 1 */
export function prefixHashes(messages) {
    const out = [''];
    let h = '';
    for (const m of messages) {
        h = createHash('sha256').update(h).update(JSON.stringify(canonical(m))).digest('hex');
        out.push(h);
    }
    return out;
}
/**
 * Identity of a routing boundary: the rolling prefix hash of the canonical
 * transcript through the last user message (`hashes[lastUser + 1]`) plus the
 * configuration that can change the decision — the (stripped) model and the
 * top-level output_config. Statements trailing the last user turn are excluded.
 */
export function requestFingerprint(boundaryHash, body) {
    const config = canonical({ model: body.model ?? null, output_config: body.output_config ?? null });
    return createHash('sha256').update(boundaryHash).update(JSON.stringify(config)).digest('hex');
}
export function lastIndexOfRole(messages, role) {
    for (let i = messages.length - 1; i >= 0; i--)
        if (messages[i].role === role)
            return i;
    return -1;
}
/** Latest effort statement Claude Code itself put in the history (its /effort level). */
export function clientEffort(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const e = messages[i].output_config?.effort;
        if (messages[i].role === 'system' && isEffort(e))
            return { effort: e, index: i };
    }
    return null;
}
export function effortMessage(effort) {
    return { role: 'system', content: [], output_config: { effort } };
}
export function isEffortStatement(m) {
    const msg = m;
    return msg?.role === 'system' && isEffort(msg.output_config?.effort);
}
/** Replay insertions into Claude Code's messages (insertions sorted by index). */
export function applyInsertions(messages, insertions) {
    const out = [];
    let k = 0;
    const sorted = [...insertions].sort((a, b) => a.index - b.index);
    for (let i = 0; i <= messages.length; i++) {
        while (k < sorted.length && sorted[k].index === i)
            out.push(effortMessage(sorted[k++].effort));
        if (i < messages.length)
            out.push(messages[i]);
    }
    return out;
}
/** Effort in force for the final message: last effort statement before it, else the top-level value. */
export function effortInForce(messages, topLevel) {
    for (let i = messages.length - 2; i >= 0; i--) {
        const e = messages[i].output_config?.effort;
        if (messages[i].role === 'system' && isEffort(e))
            return e;
    }
    return isEffort(topLevel) ? topLevel : 'medium'; // Opus 5.5 API default
}
export function addBeta(header) {
    const values = (header ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (values.some((v) => PER_MESSAGE_EFFORT_BETAS.includes(v)))
        return values.join(',');
    return [...values, PER_MESSAGE_EFFORT_BETAS[0]].join(',');
}
function blocks(content) {
    if (typeof content === 'string')
        return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content : [];
}
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Human-authored text of a user message, without Claude Code's injected reminders. */
export function userText(m) {
    if (!m || m.role !== 'user')
        return '';
    return blocks(m.content)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text.replace(REMINDER, '').trim())
        .filter(Boolean)
        .join('\n');
}
export function hasToolResults(m) {
    return !!m && m.role === 'user' && blocks(m.content).some((b) => b.type === 'tool_result');
}
/** The last user message that carries a human prompt (for the task goal). */
export function lastPrompt(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !hasToolResults(m)) {
            const t = userText(m);
            if (t)
                return t;
        }
    }
    return '';
}
/** The tool round that just finished: the last assistant's tool calls paired with the last user message's results. */
export function lastToolRound(messages) {
    const last = messages[messages.length - 1];
    let assistant;
    for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            assistant = messages[i];
            break;
        }
    }
    const results = new Map();
    for (const b of blocks(last?.content))
        if (b.type === 'tool_result' && b.tool_use_id)
            results.set(b.tool_use_id, b);
    const note = blocks(assistant?.content).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
    const batch = [];
    for (const b of blocks(assistant?.content)) {
        if (b.type !== 'tool_use' || !b.id)
            continue;
        const r = results.get(b.id);
        const text = r ? (typeof r.content === 'string' ? r.content : stringifyResult(r.content)) : '';
        batch.push({
            tool: b.name ?? 'tool',
            summary: describeToolInput(b.name ?? '', b.input),
            runner: testRunner(b.name ?? '', b.input),
            failed: r?.is_error === true || looksFailed(b.name ?? '', text),
            result: text.slice(0, 600),
        });
    }
    return { note, batch };
}
