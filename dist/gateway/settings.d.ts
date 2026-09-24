import type { Settings } from '@anthropic-ai/claude-agent-sdk';
/** Add session-only UI settings while retaining caller-supplied settings and hooks. */
export declare function withGatewaySettings(args: readonly string[], additions: Pick<Settings, 'hooks' | 'statusLine'>): string[];
/**
 * Effort changes mostly happen on tool-only steps, where Claude writes no text
 * and so no clean badge can render. One short line before each tool call gives
 * every step a message for the badge to sit on, and doubles as a readable
 * progress narration. It's short so Opus 5.5 keeps it as visible text, not a
 * progress-update thinking block.
 */
export declare const NARRATION_PROMPT = "Before each tool call, write one short sentence (under 15 words) saying what you are about to do. Keep it to a single line.";
/** Append the narration instruction to the caller's --append-system-prompt, or add one. */
export declare function withNarration(args: readonly string[], prompt?: string): string[];
