import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Effort } from '../effort.ts';
import type { RouterSnapshot } from '../router/router.ts';
import type { TaskProfile } from '../router/types.ts';
import type { Insertion } from './transcript.ts';

/**
 * Durable, append-only decision journal.
 *
 * One JSONL file per conversation key. The file name is a SHA-256 of the
 * `session|agent|first-message-hash` key, so session identifiers and transcript
 * content never appear on disk. Records carry hashes, effort levels, counters,
 * and opaque router snapshots — never prompt text, tool output, or credentials.
 *
 * A decision is appended with status `prepared` BEFORE the request is forwarded
 * upstream. Later states (`sent` / `completed` / `failed` / `unknown`) and
 * final usage are appended as small update lines carrying the same
 * `decisionId`; `records()` folds them onto their record, so the journal stays
 * append-only while still exposing each decision's latest state.
 *
 * On an in-memory thread-cache miss (eviction or restart) the gateway rebuilds
 * the thread from these records and replays exactly the statements sent before.
 */

export type JournalStatus = 'prepared' | 'sent' | 'completed' | 'failed' | 'unknown';

export interface JournalUsage {
  model?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface JournalRecord {
  decisionId: string;
  /** hash of canonical messages[0..lastUser] + model + top-level output_config */
  requestFingerprint: string;
  /** index of the user message this boundary governs */
  lastUser: number;
  /** rolling prefix hash of canonical messages[0..lastUser] — finds common ancestors */
  boundaryHash: string;
  /** every insertion applied to the forwarded request, in order */
  insertions: Insertion[];
  /** opaque controller state after this decision; restores the common ancestor */
  routerSnapshot: RouterSnapshot;
  /** policy / question-set versions, for provenance */
  policy: string;
  /** the effort this decision put in force */
  requested: Effort;
  /** effort that was in force immediately before this decision */
  current: Effort;
  kind: 'task' | 'step';
  manual: boolean;
  turn: number;
  consecutiveFailures: number;
  /** latest effort statement Claude Code itself had sent at decision time */
  clientEffort: Effort | null;
  profile: TaskProfile | null;
  status: JournalStatus;
  at: number;
  usage?: JournalUsage;
  error?: string;
}

/** Status/usage transition appended under an existing decisionId. */
export interface JournalUpdate {
  decisionId: string;
  status: JournalStatus;
  at: number;
  usage?: JournalUsage;
  error?: string;
}

export type JournalLine = JournalRecord | JournalUpdate;

export function isJournalRecord(line: JournalLine): line is JournalRecord {
  return typeof (line as JournalRecord).requestFingerprint === 'string';
}

export class Journal {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** One file per conversation; the name is a hash, never the raw key. */
  private file(key: string): string {
    const name = createHash('sha256').update(key).digest('hex').slice(0, 40);
    return path.join(this.dir, `${name}.jsonl`);
  }

  append(key: string, line: JournalLine): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    const file = this.file(key);
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  /**
   * All decisions for a conversation, in append order, with later status/usage
   * lines folded onto their record. Malformed lines are skipped.
   */
  records(key: string): JournalRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(key), 'utf8');
    } catch {
      return [];
    }
    const out: JournalRecord[] = [];
    const byId = new Map<string, JournalRecord>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: JournalLine;
      try {
        parsed = JSON.parse(line) as JournalLine;
      } catch {
        continue;
      }
      if (isJournalRecord(parsed)) {
        const rec = { ...parsed };
        byId.set(rec.decisionId, rec);
        out.push(rec);
      } else {
        const rec = byId.get(parsed.decisionId);
        if (!rec) continue;
        rec.status = parsed.status;
        rec.at = parsed.at;
        if (parsed.usage) rec.usage = parsed.usage;
        if (parsed.error) rec.error = parsed.error;
      }
    }
    return out;
  }
}
