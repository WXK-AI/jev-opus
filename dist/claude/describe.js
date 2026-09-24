/** One-line renderings of Claude Code tool inputs/results for the UI and for Jev's state. */
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
export function describeToolInput(tool, input) {
    const i = (input ?? {});
    const str = (k) => (typeof i[k] === 'string' ? i[k] : '');
    switch (tool) {
        case 'Bash': return clip(str('command').replace(/\s+/g, ' '), 160);
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return str('file_path') || str('notebook_path');
        case 'Grep': return `"${clip(str('pattern'), 80)}"${str('path') ? ` in ${str('path')}` : ''}`;
        case 'Glob': return str('pattern');
        case 'WebFetch': return str('url');
        case 'WebSearch': return str('query');
        case 'Task':
        case 'Agent': return str('description') || clip(str('prompt'), 100);
        default: {
            const json = JSON.stringify(input ?? {});
            return clip(json === '{}' ? '' : json, 120);
        }
    }
}
export function stringifyResult(response) {
    if (response == null)
        return '';
    if (typeof response === 'string')
        return response;
    if (Array.isArray(response)) {
        return response.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : JSON.stringify(b))).join('\n');
    }
    const r = response;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
        return [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n');
    }
    return JSON.stringify(response);
}
const FAIL_TEXT = /(exit code [1-9]\d*|\bError:|\bFAILED\b|\bFAIL\b|Traceback \(most recent call last\)|\bpanicked at\b|\b[1-9]\d* (failing|failed)\b|^# fail [1-9]|^\s*✖ |command not found|No such file or directory)/m;
/** Best-effort failure detection for a successful-looking tool response. */
export function looksFailed(tool, response) {
    if (response && typeof response === 'object' && !Array.isArray(response)) {
        const r = response;
        if (r.is_error === true || r.success === false || r.interrupted === true)
            return true;
        for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) {
            if (typeof r[k] === 'number' && r[k] !== 0)
                return true;
        }
    }
    if (tool !== 'Bash')
        return false;
    return FAIL_TEXT.test(stringifyResult(response).slice(0, 4000));
}
/** A conservative check identity: preserve directory, runner, flags, and test targets. */
export function testRunner(tool, input) {
    if (tool !== 'Bash')
        return undefined;
    const i = (input ?? {});
    let command = String(i.command ?? '');
    // Ignore heredoc bodies (which can themselves contain apparent commands).
    const lines = command.split('\n');
    const kept = [];
    let delimiter;
    for (const line of lines) {
        if (delimiter) {
            if (line.trim() === delimiter)
                delimiter = undefined;
            continue;
        }
        const here = line.match(/<<-?\s*['"]?(\w+)['"]?/);
        if (here) {
            delimiter = here[1];
            kept.push(line.slice(0, here.index));
        }
        else
            kept.push(line);
    }
    if (delimiter)
        return undefined;
    command = kept.join('\n').replace(/\s+2>&1(?=\s|$)/g, '');
    // Dynamic shell state cannot establish an equivalent suite reliably.
    if (/[$`]|\b(pushd|popd|eval|source|exec)\b/.test(command))
        return undefined;
    const segments = [];
    let segment = '', quote = '', escaped = false;
    for (let n = 0; n < command.length; n++) {
        const c = command[n];
        if (escaped) {
            segment += c;
            escaped = false;
            continue;
        }
        if (c === '\\' && quote !== "'") {
            segment += c;
            escaped = true;
            continue;
        }
        if (quote) {
            segment += c;
            if (c === quote)
                quote = '';
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            segment += c;
            continue;
        }
        if (c === ';' || c === '\n' || (c === '&' && command[n + 1] === '&')) {
            segments.push(segment.trim());
            segment = '';
            if (c === '&')
                n++;
            continue;
        }
        if (c === '&' || /[(){}]/.test(c))
            return undefined;
        segment += c;
    }
    if (quote || escaped)
        return undefined;
    segments.push(segment.trim());
    const scope = [typeof i.cwd === 'string' ? i.cwd : '.'];
    let check;
    const runner = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|typecheck|build|lint)\b|node --test\b|(?:npx )?(?:vitest|jest|mocha|playwright test|tsc)\b|pytest\b|python3? -m (?:pytest|unittest)\b|cargo (?:test|check|build|clippy)\b|go (?:test|vet|build)\b|make (?:test|check)\b|(?:mvn|gradle|\.\/gradlew) (?:test|check|build)\b|(?:bundle exec )?rspec\b|rake test\b|swift test\b|xcodebuild test\b)/;
    for (const raw of segments.filter(Boolean)) {
        if (/^cd\s+/.test(raw)) {
            scope.push(raw.slice(3).trim());
            continue;
        }
        // A newline in a failed pipeline or a second check is ambiguous; do not
        // attribute a compound command's success/failure to one selected suite.
        if (!runner.test(raw))
            continue;
        if (check)
            return undefined;
        check = raw.replace(/\s+2>&1/g, '').replace(/\s+\|\s*(?:tail|head|cat|tee|grep|sed|awk|wc|less)\b.*$/, '').trim();
        if (/[|<>]/.test(check))
            return undefined;
        check = JSON.stringify({ v: 2, scope: [...scope], command: check });
    }
    return check;
}
