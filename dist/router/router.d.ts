import { type Effort } from '../effort.ts';
import type { JevLike } from '../jev/client.ts';
import { type Bounds } from './policy.ts';
import type { EffortDecision, StepContext, TaskProfile } from './types.ts';
export declare function taskState(prompt: string, conversationNote?: string): string;
export declare function stepState(ctx: StepContext): string;
export interface RouterSnapshot {
    v: number;
    [key: string]: unknown;
}
export declare class EffortRouter {
    private readonly jev;
    bounds: Bounds;
    pinned: Effort | null;
    private hold;
    private base;
    constructor(opts: {
        jev: JevLike | null;
        bounds: Bounds;
        pinned?: Effort | null;
    });
    get usingJev(): boolean;
    routeTask(prompt: string, previous: Effort | null, conversationNote?: string): Promise<EffortDecision>;
    routeStep(ctx: StepContext): Promise<EffortDecision>;
    /**
     * JSON-serializable controller state, so an adapter can persist it with a
     * decision and restore the common-ancestor state after a rewind or restart.
     * Adapters must treat the value as opaque.
     */
    snapshot(): RouterSnapshot;
    restore(s: RouterSnapshot): void;
    /** Profile of the task being worked on, for building step contexts. */
    lastProfileFallback(prompt: string): TaskProfile;
    private pinnedDecision;
}
