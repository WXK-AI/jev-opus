export declare const PROJECT_ROOT: string;
export declare const CONFIG_DIR: string;
export declare const CONFIG_ENV_FILE: string;
export declare const config: {
    model: string;
    claudePath: string | undefined;
    minEffort: import("@anthropic-ai/claude-agent-sdk").EffortLevel;
    maxEffort: import("@anthropic-ai/claude-agent-sdk").EffortLevel;
    traceDir: string;
    jev: {
        apiKey: string;
        baseUrl: string;
        model: string;
        timeoutMs: number;
        retries: number;
        inputPricePerMillion: number;
    };
    /**
     * Credentials handed to the Claude Code child process. Only what is set in
     * the jev-opus config or the launching shell — never the variables a
     * parent Claude Code / desktop session injected.
     */
    claudeCredentials: {
        apiKey: string;
        oauthToken: string;
        authToken: string;
        baseUrl: string;
    };
};
