import type { JevLike } from '../jev/client.ts';
import type { Bounds } from '../router/policy.ts';
import { JevGateway } from './server.ts';
export declare const JEV_MODEL_ID = "jev/claude-opus-5-5";
export declare const STATUS_DIR: string;
export declare const GATEWAY_LOG: string;
/** Env that makes Claude Code route through the gateway and list "Opus 5.5 · Jev" in /model. */
export declare function gatewayClientEnv(baseUrl: string): Record<string, string>;
export declare function createGateway(jev: JevLike | null, bounds: Bounds, opts?: {
    port?: number;
    echo?: boolean;
    trace?: (e: Record<string, unknown>) => void;
}): JevGateway;
/** `jev-opus claude [claude args…]`: gateway in-process + the normal interactive Claude Code on top of it. */
export declare function launchClaude(jev: JevLike | null, bounds: Bounds, claudeArgs: string[], trace?: (e: Record<string, unknown>) => void): Promise<number>;
/** Claude Code statusLine command: shows the effort Jev picked for this session. */
export declare function statusline(): Promise<void>;
