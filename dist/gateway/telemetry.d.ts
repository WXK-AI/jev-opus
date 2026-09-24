import type { JournalUsage } from './journal.ts';
/** Observe protocol events without changing the forwarded bytes or retaining content. */
export declare class ResponseTelemetry {
    readonly usage: JournalUsage;
    responseId?: string;
    error?: string;
    complete: boolean;
    usageComplete: boolean;
    private buffer;
    private dropping;
    private readonly decoder;
    private readonly contentType;
    private readonly onText;
    private readonly onTool;
    private readonly cap;
    constructor(contentType: string, onTool?: (id: string) => void, onText?: () => void);
    push(chunk: Buffer): void;
    end(): void;
    private consume;
    private frame;
    private message;
    private merge;
}
