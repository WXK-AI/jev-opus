import fs from 'node:fs';
import path from 'node:path';
/** Append-only JSONL trace of every routing decision, API call, and result. */
export function createTrace(dir, warn = (m) => console.error(m)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${process.pid}.jsonl`);
    let warned = false;
    return {
        file,
        write: (event) => {
            try {
                fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
            }
            catch {
                if (!warned) {
                    warned = true;
                    warn('Jev trace logging failed; trace coverage is incomplete.');
                }
            }
        },
    };
}
