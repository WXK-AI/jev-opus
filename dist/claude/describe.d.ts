/** One-line renderings of Claude Code tool inputs/results for the UI and for Jev's state. */
export declare function describeToolInput(tool: string, input: unknown): string;
export declare function stringifyResult(response: unknown): string;
/** Best-effort failure detection for a successful-looking tool response. */
export declare function looksFailed(tool: string, response: unknown): boolean;
