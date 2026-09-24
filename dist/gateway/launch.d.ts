import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import { JevGateway } from './server.ts';
export declare const JEV_MODEL_ID = "jev/claude-opus-5-5";
export declare const STATUS_DIR: string;
export declare const GATEWAY_LOG: string;
export declare const JOURNAL_DIR: string;
/** Env that makes Claude Code route through the gateway and list "Opus 5.5 · Jev" in /model. */
export declare function gatewayClientEnv(baseUrl: string): Record<string, string>;
/** Log a line to gateway.log without touching the terminal. */
export declare function logToGateway(line: string): void;
export declare function createGateway(jev: JevLike | null, bounds: Bounds, opts?: {
    port?: number;
    echo?: boolean;
    quiet?: boolean;
    trace?: (e: Record<string, unknown>) => void;
}): JevGateway;
/** `jev-opus claude [claude args…]`: gateway in-process + the normal interactive Claude Code on top of it. */
export declare function launchClaude(jev: JevLike | null, bounds: Bounds, claudeArgs: string[], trace?: (e: Record<string, unknown>) => void): Promise<number>;
/** Claude Code statusLine command: shows the effort Jev picked for this session. */
export declare function statusline(): Promise<void>;
/** "◆ Jev · MEDIUM → HIGH → MEDIUM · verifying": the current prompt's whole path, newest last. */
export declare function formatStatusLine(s: {
    effort: string;
    previous: string | null;
    trail?: string[];
    phase: string;
    source: string;
}): string;
