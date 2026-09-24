import fs from 'node:fs';
import path from 'node:path';
import { foldJournal, readJournalFile } from './journal.ts';

/** Read-only export. Filters match a journal filename or a full/short decision ID. */
export function auditJournal(dir: string, filter = '') {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]+\.jsonl$/.test(f)).sort(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw err; }
  const query = filter.replace(/^D-/i, '').toLowerCase();
  const journals = files.map((file) => {
    const events = readJournalFile(path.join(dir, file));
    const decisions = foldJournal(events).filter((d) => !query || file.startsWith(query) || d.decisionId.toLowerCase().startsWith(query));
    const ids = new Set(decisions.map((d) => d.decisionId));
    return { journal: file, decisions, events: events.filter((e) => ids.has(e.decisionId)) };
  }).filter((j) => j.decisions.length);
  const decisions = journals.flatMap((j) => j.decisions);
  const attempts = decisions.flatMap((d) => d.attempts ?? []);
  return {
    schemaVersion: 2,
    summary: {
      decisions: decisions.length, attempts: attempts.length,
      observedOutputTokens: decisions.reduce((n, d) => n + (d.usage?.outputTokens ?? 0), 0),
      incompleteAttempts: attempts.filter((a) => a.usageComplete !== true).length,
      legacyDecisions: decisions.filter((d) => !d.decision).length,
    },
    journals,
  };
}

export function formatAudit(report: ReturnType<typeof auditJournal>): string {
  const lines = report.journals.flatMap((j) => j.decisions.map((d) => {
    const transition = d.current === d.requested ? d.requested.toUpperCase() : `${d.current.toUpperCase()} → ${d.requested.toUpperCase()}`;
    return `D-${d.decisionId.slice(0, 8)} · ${transition} · ${d.attempts?.length ?? 0} attempts (${d.attempts?.map((a) => a.status).join(', ') || 'legacy'}) · ${d.usage?.outputTokens ?? '?'} observed output tokens\n  ${d.decision?.reasons.join('; ') ?? 'Legacy record: explanation unavailable'}`;
  }));
  if (!lines.length) return 'No matching audit records.';
  lines.push(`${report.summary.incompleteAttempts} attempts with incomplete usage; ${report.summary.legacyDecisions} legacy decisions without full attribution.`);
  return lines.join('\n');
}
