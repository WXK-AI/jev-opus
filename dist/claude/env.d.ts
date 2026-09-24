import { type ClaudeCredentials } from '../config.ts';
export interface ChildEnv {
    env: Record<string, string>;
    credential: string;
}
export declare function childEnv(base?: NodeJS.ProcessEnv, opts?: {
    connectors?: boolean;
    credentials?: ClaudeCredentials;
}): ChildEnv;
