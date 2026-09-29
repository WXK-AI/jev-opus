import { type JournalRecord } from './journal.ts';
/**
 * Read-only export. Filters match a journal filename or a full/short decision
 * ID; `holds` keeps only decisions where open issues kept effort from stepping
 * down.
 */
export declare function auditJournal(dir: string, filter?: string, opts?: {
    holds?: boolean;
}): {
    schemaVersion: number;
    summary: {
        decisions: number;
        attempts: number;
        observedOutputTokens: number;
        incompleteAttempts: number;
        legacyDecisions: number;
        efforts: Record<string, number>;
        holds: {
            /** decisions with open reasoning issues */
            decisions: number;
            /** decisions where those issues kept effort from stepping down */
            blocked: number;
            /** of those, decisions that kept high, xhigh, or max in force */
            blockedAtHighOrAbove: number;
            issues: number;
            byCause: Record<string, number>;
        };
    };
    journals: {
        journal: string;
        decisions: JournalRecord[];
        events: import("./journal.ts").JournalLine[];
    }[];
};
export declare function formatAudit(report: ReturnType<typeof auditJournal>): string;
