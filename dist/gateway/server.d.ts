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
 *
 * Routing decisions are serialized per conversation branch and single-flighted
 * by request fingerprint: an identical request awaits and reuses the prepared
 * transformation instead of routing twice. Every prepared transformation is
 * written to a durable JSONL journal before it is forwarded upstream, so a
 * thread-cache eviction or a gateway restart replays exactly the statements the
 * upstream model saw. A bounded copy of each routed response is parsed for
 * usage and journaled against the decision ID.
 */
export interface GatewayOptions {
    jev: JevLike | null;
    bounds: Bounds;
    upstream?: string;
    port?: number;
    host?: string;
    statusDir?: string;
    /** durable journal directory; without it the gateway keeps no journal (tests) */
    journalDir?: string;
    onDecision?: (session: string, d: EffortDecision) => void;
    onNotice?: (message: string) => void;
    trace?: (event: Record<string, unknown>) => void;
    maxThreads?: number;
}
export declare class JevGateway {
    /** Ephemeral local endpoint; hook payloads are never forwarded upstream. */
    readonly displayHookPath: string;
    private readonly display;
    private readonly opts;
    private readonly upstream;
    private readonly journal;
    private readonly threads;
    private server;
    constructor(opts: GatewayOptions);
    listen(): Promise<string>;
    close(): Promise<void>;
    private handle;
    /**
     * Tee a bounded copy of a routed response for usage telemetry. The stream
     * pipes to the client unchanged — listeners only observe the bytes that flow,
     * so backpressure is preserved. The final journal status is `completed` when
     * the stream ends cleanly under an OK status, `failed` on an upstream error
     * status or a stream error, and `unknown` when the client went away first
     * (acceptance unknown).
     */
    private attachTelemetry;
    /**
     * Single-flight per branch: an identical request (same boundary fingerprint)
     * awaits the prepared transformation; anything else serializes on the
     * thread's queue and is decided exactly once.
     */
    private route;
    /** Apply a prepared transformation to a request's messages (retry-safe). */
    private replay;
    /**
     * Runs inside the thread's queue: restores the common-ancestor state when the
     * request branched off earlier history, decides effort, journals the prepared
     * transformation BEFORE it is forwarded upstream, and returns it.
     */
    private decide;
    private journalRecord;
    /**
     * Rewind thread state to a journaled decision: restore the opaque router
     * snapshot and rebuild the deterministic fields (prompt, profile, counters,
     * trajectory) from the surviving branch, without ever storing prompt text.
     */
    private restore;
    private journalAppend;
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
