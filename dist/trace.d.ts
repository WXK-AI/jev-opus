/** Append-only JSONL trace of every routing decision, API call, and result. */
export declare function createTrace(dir: string): {
    file: string;
    write: (event: Record<string, unknown>) => void;
};
