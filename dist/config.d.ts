export declare const PROJECT_ROOT: string;
export declare const CONFIG_DIR: string;
export declare const CONFIG_ENV_FILE: string;
/**
 * Variables written in jev-opus .env files, kept separate from the inherited
 * environment. A parent Claude Code session exports its own ANTHROPIC_* /
 * CLAUDE_* keys; without provenance those would be indistinguishable from
 * credentials the user configured for the child.
 *
 * Precedence matches the old `process.loadEnvFile` loop: values already in the
 * environment win, then the repo-clone .env, then the user config file.
 */
export declare const envFileVars: Map<string, {
    value: string;
    file: string;
}>;
export interface ClaudeCredential {
    /** The credential value; empty when unset. */
    value: string;
    /** Where the value came from: a JEV_OPUS_* variable, a jev-opus .env file, or the inherited environment. */
    source: string;
}
export interface ClaudeCredentials {
    apiKey: ClaudeCredential;
    oauthToken: ClaudeCredential;
    authToken: ClaudeCredential;
    baseUrl: ClaudeCredential;
}
/**
 * The credential handed to the Claude Code child process. Only JEV_OPUS_*
 * variables and values written in a jev-opus .env file are used. A plain
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN found in the environment may
 * have been injected by a parent Claude session — `childEnv` strips it, so
 * using it here would silently reintroduce exactly what was removed. It is
 * honored only when `inherit` (JEV_OPUS_INHERIT_CREDENTIALS=1).
 */
export declare function resolveClaudeCredentials(env: NodeJS.ProcessEnv, fileVars: ReadonlyMap<string, {
    value: string;
    file: string;
}>, opts?: {
    inherit?: boolean;
}): ClaudeCredentials;
export declare const config: {
    model: string;
    claudePath: string | undefined;
    minEffort: import("@anthropic-ai/claude-agent-sdk").EffortLevel;
    maxEffort: import("@anthropic-ai/claude-agent-sdk").EffortLevel;
    traceDir: string;
    jev: {
        provider: 'typesafe' | 'openrouter';
        apiKey: string;
        openrouterKey: string;
        baseUrl: string;
        model: string;
        openrouterUrl: string;
        openrouterModel: string;
        deadlineMs: number;
        retries: number;
        breakerThreshold: number;
        breakerCooldownMs: number;
        inputPricePerMillion: number;
    };
    claudeCredentials: ClaudeCredentials;
};
