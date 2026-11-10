# Changelog

## Unreleased

- Fable 5.2, Sonnet 5.5 and Haiku 5.5: the gateway lists them as "<model> · Jev" (`jev/claude-fable-5-2`, `jev/claude-sonnet-5-5`, `jev/claude-haiku-5-5`) next to "Opus 5.5 · Jev" in `/v1/models`, and `JEV_OPUS_MODEL` makes `jev-opus claude` select one of them in /model. All four accept `output_config.effort` low…max. Opus 5.5 stays the default.

## 0.5.0-abby.1 - 2026-10-08

- `jev-opus claude` sets `ENABLE_TOOL_SEARCH=true`: Claude Code turns tool search off behind a non-Anthropic `ANTHROPIC_BASE_URL`, so every MCP schema was loaded into each prompt (~47 % of the context at session start). A value already in the environment wins.

## 0.5.0-abby.0 - 2026-10-08

First release of the abby-inc fork of [WXK-AI/jev-opus](https://github.com/WXK-AI/jev-opus) (MIT), based on upstream 0.4.8. The routing, journal and cache-replay design is entirely WXK-AI's work. The changes below only adapt it to a daily-driver Claude Code setup.

- `jev-opus claude` keeps the parent environment (`CLAUDE_CODE_*`, `OTEL_*`, `MCP_*`, `ANTHROPIC_MODEL`, ...). Only what would bypass the gateway or override Jev is removed: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`, and the parent-session markers `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`. The headless driver and `doctor` keep the old full strip.
- `JEV_OPUS_MODE=shadow`: Jev decides and the decision is journaled and logged, but the request is forwarded unchanged (no effort statement, no beta header, no `--model` override, no statusline or inline effort display). An unknown mode value is an error, never a silent fallback to active.
- Default effort ceiling stays `high`; `xhigh`/`max` need `JEV_OPUS_MAX_EFFORT` explicitly. Now covered by tests.
- Plugin skills run the local `jev-opus` binary, else an exact pinned `github:abby-inc/jev-opus#v<version>`, instead of `npx jev-opus@latest`. `npm run check:version` keeps the pins in step with `package.json`.
- A `--model` passed to `jev-opus claude` is never replaced; the Jev model is only the default when none is given (without the `jev/` model, no routing happens).
- CI checks version consistency; the release workflow tags `v<version>` and creates a GitHub release from this file when `main` gets a new version. No npm publish.

## 0.4.8

Upstream release. See [WXK-AI/jev-opus](https://github.com/WXK-AI/jev-opus/releases).
