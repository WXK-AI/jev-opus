/** One-line renderings of Claude Code tool inputs/results for the UI and for Jev's state. */
import type { CommandKind, FailureCause, ToolCallSummary } from '../router/types.ts';
export declare function describeToolInput(tool: string, input: unknown): string;
export declare function stringifyResult(response: unknown): string;
export interface ToolOutcome {
    failed: boolean;
    suspect: boolean;
    cause?: FailureCause;
    kind?: CommandKind;
    /** marker lines when failed/suspect (the same text later fingerprinted), else the head of the output */
    evidence: string;
}
/**
 * Classify one tool result. `text` is the rendered result, `isError` the
 * tool's own error flag, `response` an optional structured response (Agent
 * SDK hooks) that may carry exit status or an interrupt flag.
 */
export declare function classifyToolResult(tool: string, input: unknown, text: string, isError: boolean, response?: unknown): ToolOutcome;
/** The router's view of one tool call. */
export declare function summarizeToolCall(tool: string, input: unknown, text: string, isError: boolean, id?: string, response?: unknown): ToolCallSummary;
interface Scan {
    /** a check summary was found */
    summaries: boolean;
    /** summary lines reporting a positive failure count */
    failures: string[];
    /** marker lines */
    markers: string[];
    /** how many marker lines matched a strong marker */
    strong: number;
    /** lines naming an environment blocker (kept as evidence for classification) */
    environment: string[];
    /** the output shows more ran than the check behind the last summary: a script started after it, or a runner reported failing */
    uncovered: boolean;
}
export declare function scanOutput(text: string): Scan;
/** Simple commands of a shell script (see parsePipelines). */
export declare function shellSegments(command: string): string[];
export interface CommandShape {
    /** what the command does overall (see CommandKind) */
    kind: CommandKind;
    /** simple commands that run a check */
    checks: number;
    /** a pipeline that prints stored content (a file, a log, a diff) reaches the output */
    readsContent: boolean;
    /** some of that content is a log or saved output */
    readsLogs: boolean;
}
/**
 * What a Bash command does, judged from every simple command in it: any
 * check makes it a check; otherwise the most consequential kind wins, and it
 * is a lookup only when everything in it only reads. A pipeline's output
 * comes from its first command (`cat log | grep x` prints the log;
 * `npm test | tail` prints the test run).
 */
export declare function analyzeCommand(command: string, depth?: number): CommandShape;
export declare function commandKind(command: string): CommandKind;
/** A conservative check identity: preserve directory, runner, flags, and test targets. */
export declare function testRunner(tool: string, input: unknown): string | undefined;
export {};
