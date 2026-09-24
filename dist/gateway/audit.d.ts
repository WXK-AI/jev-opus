/** Read-only export. Filters match a journal filename or a full/short decision ID. */
export declare function auditJournal(dir: string, filter?: string): {
    schemaVersion: number;
    summary: {
        decisions: number;
        attempts: number;
        observedOutputTokens: number;
        incompleteAttempts: number;
        legacyDecisions: number;
    };
    journals: {
        journal: string;
        decisions: import("./journal.ts").JournalRecord[];
        events: import("./journal.ts").JournalLine[];
    }[];
};
export declare function formatAudit(report: ReturnType<typeof auditJournal>): string;
