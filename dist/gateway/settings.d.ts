import type { Settings } from '@anthropic-ai/claude-agent-sdk';
/** Add session-only UI settings while retaining caller-supplied settings and hooks. */
export declare function withGatewaySettings(args: readonly string[], additions: Pick<Settings, 'hooks' | 'statusLine'>): string[];
