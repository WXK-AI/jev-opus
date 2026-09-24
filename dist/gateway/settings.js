import fs from 'node:fs';
/** Add session-only UI settings while retaining caller-supplied settings and hooks. */
export function withGatewaySettings(args, additions) {
    if (!additions.hooks && !additions.statusLine)
        return [...args];
    const out = [...args];
    let index = -1;
    let inline = false;
    for (let i = 0; i < out.length && out[i] !== '--'; i++) {
        if (out[i] === '--settings') {
            if (!out[i + 1])
                throw new Error('--settings needs a JSON object or settings file');
            index = i;
            inline = false;
            i++;
        }
        else if (out[i].startsWith('--settings=')) {
            index = i;
            inline = true;
        }
    }
    let settings = {};
    if (index >= 0) {
        const value = inline ? out[index].slice('--settings='.length) : out[index + 1];
        let raw = value;
        if (!value.trimStart().startsWith('{')) {
            const stat = fs.statSync(value);
            if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
                throw new Error('--settings must be a regular JSON file no larger than 2 MiB');
            raw = fs.readFileSync(value, 'utf8');
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('--settings must contain a JSON object');
        settings = parsed;
    }
    if (additions.statusLine && !settings.statusLine)
        settings.statusLine = additions.statusLine;
    if (additions.hooks) {
        settings.hooks = { ...settings.hooks };
        for (const [event, handlers] of Object.entries(additions.hooks)) {
            const existing = settings.hooks[event] ?? [];
            if (!Array.isArray(existing))
                throw new Error(`--settings hooks.${event} must be an array`);
            settings.hooks[event] = [...existing, ...handlers];
        }
    }
    const json = JSON.stringify(settings);
    if (index < 0)
        out.unshift('--settings', json);
    else if (inline)
        out[index] = `--settings=${json}`;
    else
        out[index + 1] = json;
    return out;
}
