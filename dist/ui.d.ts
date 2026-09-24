import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { Effort } from './effort.ts';
import type { SessionObserver, TaskReport } from './claude/session.ts';
import type { EffortDecision } from './router/types.ts';
export declare const c: {
    dim: (s: string) => string;
    bold: (s: string) => string;
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    magenta: (s: string) => string;
    cyan: (s: string) => string;
};
export declare const fmtEffort: (e: Effort) => string;
export declare function formatDecision(d: EffortDecision, verbose: boolean): string;
/** "high×2 → medium×3 → low" */
export declare function effortPath(efforts: readonly string[]): string;
export declare function formatReport(r: TaskReport, jevCostUsd: number): string;
export declare class Terminal {
    private rl;
    verbose: boolean;
    /** route all chatter to stderr so --json keeps stdout machine-readable */
    private readonly toStderr;
    private readonly out;
    constructor(verbose: boolean, toStderr?: boolean);
    private get iface();
    ask(question: string): Promise<string>;
    close(): void;
    observer(): SessionObserver;
    /** Interactive approval for tools the permission mode doesn't auto-allow. */
    canUseTool(): CanUseTool;
}
