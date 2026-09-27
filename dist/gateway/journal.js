import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export function isJournalRecord(line) {
    return !!line && typeof line === 'object' && typeof line.requestFingerprint === 'string';
}
export class Journal {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    /** One file per conversation; the name is a hash, never the raw key. */
    file(key) {
        const name = createHash('sha256').update(key).digest('hex').slice(0, 40);
        return path.join(this.dir, `${name}.jsonl`);
    }
    append(key, line) {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(this.dir, 0o700);
        }
        catch { /* best effort */ }
        const file = this.file(key);
        repairIncompleteTail(file);
        fs.appendFileSync(file, `${JSON.stringify({ schemaVersion: 2, eventId: randomUUID(), ...line })}\n`, { mode: 0o600, flush: true });
        try {
            fs.chmodSync(file, 0o600);
        }
        catch { /* best effort */ }
    }
    /**
     * All decisions for a conversation, in append order, with later status/usage
     * lines folded onto their record. Corrupt records fail recovery explicitly.
     */
    records(key) {
        return foldJournal(this.events(key));
    }
    events(key) {
        return readJournalFile(this.file(key));
    }
}
/** An interrupted append must not turn into a corrupt middle line on the next write. */
function repairIncompleteTail(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r+');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
    try {
        let end = fs.fstatSync(fd).size;
        if (end === 0)
            return;
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, end - 1);
        if (last[0] === 10)
            return;
        // Read only the unfinished final line. Completed journals cost one byte
        // to check, regardless of their size.
        const chunks = [];
        let start = end;
        while (start > 0) {
            const length = Math.min(4096, start);
            const chunk = Buffer.alloc(length);
            fs.readSync(fd, chunk, 0, length, start - length);
            const newline = chunk.lastIndexOf(10);
            chunks.unshift(chunk.subarray(newline + 1));
            start -= length;
            if (newline >= 0) {
                start += newline + 1;
                break;
            }
        }
        const tail = Buffer.concat(chunks).toString('utf8');
        let complete = false;
        try {
            const parsed = JSON.parse(tail);
            complete = !!parsed && typeof parsed === 'object' && typeof parsed.decisionId === 'string';
        }
        catch { /* incomplete JSON: discard this one line */ }
        if (complete)
            fs.writeSync(fd, '\n', end);
        else
            fs.ftruncateSync(fd, start);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function readJournalFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const lines = raw.split('\n');
    // A crash during an append leaves at most one partial line, at the very end
    // (no trailing newline). Skip that one; corruption anywhere else still fails.
    const truncatedTail = !raw.endsWith('\n') && lines.length > 0;
    const lastIndex = lines.length - 1;
    return lines.flatMap((line, index) => (line.trim() ? [{ line, index }] : [])).flatMap(({ line, index }) => {
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            if (truncatedTail && index === lastIndex)
                return [];
            throw new Error(`Invalid journal JSON at line ${index + 1}`);
        }
        if (!value || typeof value !== 'object' || typeof value.decisionId !== 'string') {
            throw new Error(`Invalid journal event at line ${index + 1}`);
        }
        return [value];
    });
}
/** Recovery projection with per-attempt accounting. Raw annotations remain available via events(). */
export function foldJournal(lines) {
    const byId = new Map();
    for (const line of lines) {
        if (isJournalRecord(line)) {
            byId.set(line.decisionId, { ...line, attempts: [] });
            continue;
        }
        if ('event' in line)
            continue;
        const rec = byId.get(line.decisionId);
        if (!rec)
            continue;
        rec.status = line.status;
        rec.updatedAt = line.at;
        if (line.attemptId) {
            let attempt = rec.attempts.find((a) => a.attemptId === line.attemptId);
            if (!attempt) {
                attempt = { attemptId: line.attemptId, status: line.status, sentAt: line.at };
                rec.attempts.push(attempt);
            }
            attempt.status = line.status;
            if (line.status !== 'sent')
                attempt.completedAt = line.at;
            if (line.usage)
                attempt.usage = line.usage;
            if (line.error)
                attempt.error = line.error;
            if (line.responseId)
                attempt.responseId = line.responseId;
            if (line.providerRequestId)
                attempt.providerRequestId = line.providerRequestId;
            if (line.usageComplete !== undefined)
                attempt.usageComplete = line.usageComplete;
            rec.usage = sumUsage([rec.legacyUsage, ...rec.attempts.map((a) => a.usage)]);
        }
        else {
            // Legacy events lack attempt identity: retain their original projection,
            // never invent retry attribution or claim complete attempt coverage.
            if (line.usage) {
                rec.legacyUsage = line.usage;
                rec.usage = sumUsage([rec.legacyUsage, ...rec.attempts.map((a) => a.usage)]);
            }
        }
        if (line.error)
            rec.error = line.error;
        else if (line.status === 'completed')
            delete rec.error;
    }
    return [...byId.values()];
}
function sumUsage(values) {
    const found = values.filter((v) => !!v);
    if (!found.length)
        return undefined;
    const result = { model: found.at(-1).model, stopReason: found.at(-1).stopReason };
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
        const counts = found.map((v) => v[key]).filter((v) => v !== undefined);
        if (counts.length)
            result[key] = counts.reduce((a, b) => a + b, 0);
    }
    return result;
}
