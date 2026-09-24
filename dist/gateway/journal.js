import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export function isJournalRecord(line) {
    return typeof line.requestFingerprint === 'string';
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
        fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
        try {
            fs.chmodSync(file, 0o600);
        }
        catch { /* best effort */ }
    }
    /**
     * All decisions for a conversation, in append order, with later status/usage
     * lines folded onto their record. Malformed lines are skipped.
     */
    records(key) {
        let raw;
        try {
            raw = fs.readFileSync(this.file(key), 'utf8');
        }
        catch {
            return [];
        }
        const out = [];
        const byId = new Map();
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (isJournalRecord(parsed)) {
                const rec = { ...parsed };
                byId.set(rec.decisionId, rec);
                out.push(rec);
            }
            else {
                const rec = byId.get(parsed.decisionId);
                if (!rec)
                    continue;
                rec.status = parsed.status;
                rec.at = parsed.at;
                if (parsed.usage)
                    rec.usage = parsed.usage;
                if (parsed.error)
                    rec.error = parsed.error;
            }
        }
        return out;
    }
}
