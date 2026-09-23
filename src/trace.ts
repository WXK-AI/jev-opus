import fs from 'node:fs';
import path from 'node:path';

/** Append-only JSONL trace of every routing decision, API call, and result. */
export function createTrace(dir: string): { file: string; write: (event: Record<string, unknown>) => void } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${process.pid}.jsonl`);
  return {
    file,
    write: (event) => {
      try {
        fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
      } catch {
        // tracing must never break a run
      }
    },
  };
}
