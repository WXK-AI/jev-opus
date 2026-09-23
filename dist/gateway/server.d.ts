import type { Effort } from '../effort.ts';
import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import type { EffortDecision } from '../router/types.ts';
/**
 * Local Anthropic-Messages gateway. Claude Code (CLI, IDE extensions, Agent SDK)
 * points ANTHROPIC_BASE_URL here and picks the "jev/…" model in /model.
 * Requests for that model get their prefix stripped and a Jev-chosen effort
 * inserted as a per-message effort statement. Everything else passes through
 * byte-for-byte. Credentials are forwarded unchanged and never logged.
 */
export interface GatewayOptions {
    jev: JevLike | null;
    bounds: Bounds;
    upstream?: string;
    port?: number;
    host?: string;
    statusDir?: string;
    onDecision?: (session: string, d: EffortDecision) => void;
    onNotice?: (message: string) => void;
    trace?: (event: Record<string, unknown>) => void;
    maxThreads?: number;
}
export declare class JevGateway {
    private readonly opts;
    private readonly upstream;
    private readonly threads;
    private server;
    constructor(opts: GatewayOptions);
    listen(): Promise<string>;
    close(): Promise<void>;
    private handle;
    /** Decide effort for this request and return the messages with all insertions replayed. */
    private route;
    private thread;
    private writeStatus;
}
export declare function readStatus(statusDir: string, session: string): {
    effort: Effort;
    previous: Effort | null;
    phase: string;
    source: string;
    at: number;
} | null;
