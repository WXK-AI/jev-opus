# Threat model

## What this project does and where untrusted input enters

jev-opus (npm `jev-opus` 0.4.8, MIT, bin `dist/cli.js`) is a Node 22.18+ / TypeScript CLI that runs Claude Code on `claude-opus-5-5` and asks the TypeSafe Jev "System-1" service (or OpenRouter, which reaches the same Jev model) to pick an effort level (low, medium, high, and up to max) before each step. It runs in three modes:

- **Gateway mode** (`jev-opus claude`, `jev-opus gateway`): starts a local HTTP server (`src/gateway/server.ts`) and points Claude Code at it with `ANTHROPIC_BASE_URL`. The gateway rewrites `/v1/messages` requests and forwards them to the Anthropic API.
- **Driver mode** (`jev-opus "task"`, `src/claude/session.ts`): runs Claude Code headless through `@anthropic-ai/claude-agent-sdk`. A hook changes effort after each tool batch.
- **Plugin** (`plugin/`, `.claude-plugin/`): two Claude Code skills, `/jev` and `/jev-route`. They tell Claude to run `npx -y jev-opus@latest` in the user's shell.

Trust boundary. The user's machine, the user's shell environment, and jev-opus configuration files are trusted. These inputs are untrusted:

- HTTP requests to the gateway port. The gateway checks a token before it forwards, except for the display hook path (see Components).
- Model responses from the Anthropic API. The gateway passes them through to Claude Code unchanged, and only parses them for usage (`src/gateway/telemetry.ts`).
- Tool inputs and outputs that Claude Code reports (hook payloads, `PostToolBatch` results, `src/claude/describe.ts`, `src/router/state.ts`).
- Jev API responses (`src/jev/client.ts`, `ask()` and `validateAnswers`).
- Task text. The `/jev` skill's `$ARGUMENTS` is written by the model, and can contain text from files or web pages the model has read.
- `--settings` file contents (`src/gateway/settings.ts`).
- Workspace Claude Code settings, which are loaded by default (`project,local`, see Components).

Operator-controlled (trusted): environment variables, the `.env` files that `src/config.ts` reads (`PROJECT_ROOT/.env` and `$CONFIG_DIR/.env`), CLI flags, and `~/.config/jev-opus/`. The workspace `.env` is not read. `PROJECT_ROOT` is the jev-opus package root, not the user's working directory.

## Components that matter most / least

Matter most (in scope):

1. **Gateway listener, auth, and forwarding.** `src/gateway/server.ts` (`listen` 140-165, `handle` 171-313) and `src/gateway/launch.ts` (`gatewayClientEnv` 20-27, `createGateway` 45-66, `launchClaude` 133-166).
   - **Bind address.** `server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1')` (`server.ts:154`). No CLI flag or environment variable sets `host`, and `createGateway` does not pass it, so the listener is loopback-only as shipped. Port: `jev-opus claude` uses an ephemeral port (`port` undefined, so 0). `jev-opus gateway` uses 47821 unless `--port` is given (`cli.ts:145`).
   - **Caller check.** Every request except the display hook needs header `x-jev-gateway-token` (`GATEWAY_AUTH_HEADER`, `server.ts:112`). The token is 32 random bytes per process (`server.ts:131`), must be at least 16 header-safe characters, and is compared with `timingSafeEqual` (`server.ts:198-205`). A missing or wrong token gets 401 and the body is not read. There is no `Host` or `Origin` check and no CORS header. The token is the only gate.
   - **Unauthenticated exception: display hook.** `POST /_jev/hooks/<uuid>` (`server.ts:117`, `174-197`) needs no token. The UUID is random per gateway instance. The body is capped at 1 MiB. The handler (`src/gateway/display.ts` `handle`, 103-) returns display JSON only, and may call `onAnnotation`, which writes an annotation record to the journal (`display.ts:127`). I did not trace every field that annotation can write.
   - **Forwarding.** For non-hook requests, every incoming header is copied except hop-by-hop headers and the gateway token (`server.ts:215-217`). That includes Claude Code's `x-api-key` or `authorization`. The request goes to `this.upstream + req.url` (`server.ts:277`). `upstream` is `https://api.anthropic.com` unless `JEV_GATEWAY_UPSTREAM` is set (`server.ts:136`, `launch.ts:52`). Redirects are not followed (`server.ts:282`). Request bodies are capped at 64 MiB before dispatch (`server.ts:210`). Response headers are copied except a drop list (`server.ts:290`).
   - **URL concatenation.** `this.upstream + req.url` uses the raw request target. A request target that starts with `@` produces a URL whose host changes, with `api.anthropic.com` as userinfo. I checked in Node v22.23: `new URL(...)` then yields the attacker host. `fetch` rejects URLs that carry userinfo ("Request cannot be constructed from a URL that includes credentials"), so the attack did not reach another host in that check. There is no explicit validation. This needs the token anyway.
   - **Body rewriting.** For `/v1/messages` and `/v1/messages/count_tokens` with a `jev/` model ID, the gateway rewrites the model to the real ID, inserts effort messages, and adds a beta header (`server.ts:223-256`). Requests with no `jev/` model are passed through.
   - **`/v1/models`.** A non-streamed response gets a synthetic `jev/claude-opus-5-5` entry (`server.ts:292-300`).
   - **Jev calls.** `src/jev/client.ts` POSTs to `JEV_BASE_URL` (default `https://api.typesafe.ai/v1/systemone`), or to `JEV_OPENROUTER_URL` (default `https://openrouter.ai/api/alpha/decisions`) for OpenRouter (`client.ts:185`). The header is `Authorization: Bearer <key>` (`client.ts:269`). The URL is used exactly as set in the environment. The code does not require `https:`, and does not check the host.
2. **Credential resolution and the child environment.** `src/config.ts` (`.env` loader around lines 23-34; `resolveClaudeCredentials`; `config.jev` at 105-111), `src/claude/env.ts` (`childEnv`).
   - `childEnv` copies the whole parent environment except names matching `^(ANTHROPIC_|CLAUDE|MCP_|OTEL_)` and the `ROUTER_SECRETS` set (`env.ts:18-21`, `35`). The set is `JEV_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `JEV_OPUS_ANTHROPIC_API_KEY`, `JEV_OPUS_CLAUDE_OAUTH_TOKEN`, `JEV_OPUS_ANTHROPIC_AUTH_TOKEN`. Every other variable (for example cloud or GitHub tokens) is passed to the Claude child.
   - The Anthropic credential is set as `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`) in the child (`env.ts:42-51`). A plain `ANTHROPIC_*` value counts only if it came from a jev-opus `.env` file or from `JEV_OPUS_*`, or if `JEV_OPUS_INHERIT_CREDENTIALS=1` (`config.ts`, `resolveClaudeCredentials`).
   - `ANTHROPIC_BASE_URL` in the child comes only from `JEV_OPUS_ANTHROPIC_BASE_URL` (`env.ts:51`). In gateway mode it is overwritten by the gateway URL (`launch.ts:138`).
   - The loader copies every key from both `.env` files into `process.env` when unset (`config.ts:34`). Any key in those files, such as `JEV_GATEWAY_UPSTREAM` or `JEV_BASE_URL`, takes effect.
3. **Hooks, statusline, and process spawn.** `src/gateway/launch.ts` (`checkClaude` 80-88, `launchClaude` 133-166), `src/gateway/settings.ts`, `src/gateway/display.ts` (`inlineEffortSettings` 141-143).
4. **Jev client and router.** `src/jev/client.ts` (`ask` 225-310, `validateAnswers` 116-), `src/router/router.ts`. The default evaluator mode is summary-only, using fixed labels and counts. `JEV_OPUS_EVALUATOR_CONTENT=full` sends raw prompts (up to 3000 characters) and tool output excerpts to Jev (`router.ts:13-16`). That is a documented opt-in.
5. **Trace, journal, and log writers.** See the next section.
6. **Plugin skills.** `plugin/skills/jev/SKILL.md` and `plugin/skills/jev-route/SKILL.md`. These are shell instructions that Claude follows. See Components 3 and the severity guide.
7. **Terminal output.** `src/ui.ts` `observer` (102-103) prints assistant text and tool summaries to the terminal with no control-character stripping. `src/claude/describe.ts:221` strips SGR sequences from tool result lines only.

Matter less: `src/router/*` (`policy.ts`, `heuristics.ts`, `questions.ts`, `state.ts`, `types.ts`, `router.ts`) contains no `node:fs`, `node:net`, `fetch`, or `child_process` use, so it is pure decision logic. `src/effort.ts`, `src/gateway/telemetry.ts` and `transcript.ts` are pure parsing and rewriting helpers. `src/gateway/display.ts` returns display text and annotations only.

Out of scope:

- The Anthropic API, Claude Code itself (its permission engine, its tools, its hook and settings semantics, and its workspace-trust prompt), the Claude Agent SDK, the TypeSafe Jev service, OpenRouter, Node.js, npm, and the user's shell and other programs.
- `tests/`, `evals/` (developer harness that runs tasks in git worktrees with `spawnSync`, run by the maintainer), `docs/` (review notes).
- `dist/`. It is tracked in git, and CI runs `npm run build && git diff --exit-code -- dist`, so it should mirror `src/`. I did not diff it.
- `.github/workflows/`. Publishing uses npm OIDC trusted publishing (`release.yml`). I did not review it in depth.
- `node_modules/`, and the `.env` file in the repo root (gitignored, not tracked, not printed here).

Trace, journal, and log files. The config directory is `$JEV_OPUS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/jev-opus`, else `~/.config/jev-opus` (`config.ts`).

- `traces/<ISO-timestamp>-<pid>.jsonl` (`config.ts:105`, `src/trace.ts`). Directory mode 0700, files 0600. Contents: a `session` event with the absolute `cwd`, model, bounds, router mode, and the credential source label (`cli.ts:172`). The label names a variable or file path, never a value. Also `decision` events (`session.ts:183`, `470`), `gateway_decision` events (`server.ts:585`), `api_call` token counts (`session.ts:316`), and a `result` event with costs and per-call efforts (`session.ts:416`). Driver-mode `decision` events include the raw `jevError`, which can contain up to 200 characters of a Jev HTTP error body (`client.ts:276`). Gateway-mode decisions have `jevError` replaced by a fixed code (`server.ts:525`).
- `journal/<sha256(session|agent|first-message-hash)[:40]>.jsonl` (`src/gateway/journal.ts:126-138`). Directory 0700, files 0600, written before the request is forwarded. Records hold hashes, effort levels, decision reasons, usage, and response IDs. The README (lines 209-213) says the journal never holds prompts, tool output, or credentials. The router snapshot drops labels before it is serialized (`src/router/state.ts:236-237`). I did not verify every field of the snapshot.
- `gateway.log` (`launch.ts:33`). Mode 0600. Decision lines, notices, and `gateway error: <message>` lines (`server.ts:144`). ANSI codes are stripped.
- `status/<session>.json` (`server.ts:665`). Written with default file mode (no explicit mode). Holds effort trail, phase, and source only.
- Read-back: `jev-opus audit` reads the journal directory (`src/gateway/audit.ts`). Files are local only.
- Retention: nothing prunes traces, journals, or `gateway.log`. The only deletion is of status files (`server.ts:650`). Disk use grows without a limit.

Secrets handling.

- **Anthropic credential.** Candidate sources: `JEV_OPUS_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY` in a jev-opus `.env`, `JEV_OPUS_CLAUDE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` in a `.env`, `JEV_OPUS_ANTHROPIC_AUTH_TOKEN`, and inherited values only with `JEV_OPUS_INHERIT_CREDENTIALS=1`. `childEnv` uses the API key first, then the OAuth token, then the auth token. If none is set, Claude Code's own `claude auth login` is used. The value goes into the child's environment (`env.ts:42-44`). Claude Code then sends it to the gateway, which forwards it upstream.
- **Jev key** (`JEV_API_KEY` or `TYPESAFE_API_KEY`, format `apikey_…`; or `OPENROUTER_API_KEY`, format `sk-or-…`). Held in the jev-opus process, used only as the Bearer header to the Jev URL (`client.ts:269`). It is removed from the child environment (`env.ts:18-21`).
- **Gateway token.** Generated per process. Passed to the child as `ANTHROPIC_CUSTOM_HEADERS: x-jev-gateway-token: <token>` (`launch.ts:23`, `138`). The child therefore holds it in its environment, and so do any processes it spawns, unless Claude Code scrubs it (not checked). The standalone `jev-opus gateway` prints the full env block, token included, to stdout (`cli.ts:221-236`, function `gateway()`).
- **Storage on disk.** `jev-opus init` writes `$CONFIG_DIR/.env` with mode 0600, in a 0700 directory (`cli.ts:255-271`). It refuses to overwrite an existing file. The keys can also come from the shell environment or the package-root `.env`.
- **Logging.** I found no code that writes the Anthropic, Jev, or OpenRouter key value to a log, trace, journal, or status file. `JEV_GATEWAY_DEBUG=1` logs header names only (`server.ts:236`). Fetch error messages and Jev HTTP errors (`client.ts:276`) are logged, and the Jev error may include response body text.
- **Child argv.** The inline hook URL, which includes the display UUID, is passed to the child in `--settings` JSON on the command line (`launch.ts:146-150`, `display.ts:141-143`). Process argument lists can be visible to other local users, depending on the OS.

Hooks and commands that run on the user's machine.

- `jev-opus` spawns the `claude` binary (`launch.ts:157`) from `JEV_OPUS_CLAUDE_PATH` or the first new-enough `claude` on `PATH` (`launch.ts:80-127`). Argument list: the user's CLI arguments plus injected settings. No shell is used.
- Statusline: `process.execPath cli.js statusline`, with single-quote quoting (`launch.ts:143`). It reads Claude Code's JSON from stdin. `readStatus` validates the session ID with `^[\w-]+$` (`server.ts:703-704`).
- Default settings: `--settings` defaults to `project,local` (`cli.ts:47`, README line 165). So `.claude/settings*.json` in the workspace, including any hooks defined there, is loaded into the Claude child. Claude Code's trust handling for SDK-driven runs is not visible in this code (see unclear items).
- Permissions: default `acceptEdits` (`cli.ts:45`). `--yolo` sets `bypassPermissions` with `allowDangerouslySkipPermissions` (`session.ts:256`).
- **Plugin skills.** `plugin/skills/jev/SKILL.md` has `allowed-tools: Bash` (line 5) and this command (lines 17-19):

  ```
  npx -y jev-opus@latest --permission-mode auto -w "$PWD" <<'JEV_TASK'
  $ARGUMENTS
  JEV_TASK
  ```

  The quoted heredoc stops `$` expansion in the body. A line inside `$ARGUMENTS` that is exactly `JEV_TASK` ends the heredoc, and any text after it runs as shell. I confirmed this with bash, using only `echo` in a scratch directory. The `@latest` tag is not pinned, so each run fetches whatever version npm currently serves.
- No `exec`, `eval`, or `new Function` is applied to model or Jev output anywhere in `src/`.

Unclear from the code (not guessed):

1. Whether Claude Code's workspace-trust prompt applies to SDK-driven `jev-opus "task"` runs that load `project,local` settings.
2. In gateway mode, `JEV_OPUS_ANTHROPIC_BASE_URL` is overwritten for the child (`launch.ts:138`), and the gateway upstream comes only from `JEV_GATEWAY_UPSTREAM`. I did not find where `JEV_OPUS_ANTHROPIC_BASE_URL` is used in gateway mode. Whether that is intended is unclear.
3. Whether Claude Code's Bash tool subprocesses inherit `ANTHROPIC_API_KEY` and `ANTHROPIC_CUSTOM_HEADERS` from the child environment. That depends on Claude Code.
4. Whether `allowed-tools: Bash` in the skill frontmatter pre-approves the skill's Bash command. That depends on Claude Code's skill semantics.
5. What the display hook's annotation path can write to the journal, beyond the bounded fields I read.
6. The full set of fields in the persisted router snapshot.
7. Whether `dist/` matches `src/`.

## How to exercise it

- Build: `npm run build` (`rm -rf dist && tsc -p tsconfig.build.json`).
- Checks: `npm run typecheck`; `npm test` (`node --test --test-concurrency=1 tests/*.test.ts`).
- Gateway without a real account: construct `JevGateway` (`src/gateway/server.ts`) with `jev: null`, `port: 0`, `journalDir` set to a temp directory, and `upstream` set to a local stub HTTP server. Then send raw requests with and without `x-jev-gateway-token`. Also send to `/_jev/hooks/<wrong-uuid>` and to the real display hook path.
- Jev without a real key: point `JEV_BASE_URL` at a local stub. Tests already use placeholder keys such as `apikey_test`. Use placeholders only.
- Config: start from `.env.example` in a temporary `JEV_OPUS_CONFIG_DIR`. Do not use real keys.
- Trace and journal: run the code under a temporary `JEV_OPUS_CONFIG_DIR` and `JEV_OPUS_TRACE_DIR`, then inspect the JSONL files.
- Skill: `plugin/skills/*/SKILL.md` is interpreted by Claude Code. It is not run by jev-opus itself.

## How you rate severity

- **Critical.**
  - The gateway accepts or serves API traffic without the token, or from a non-loopback origin.
  - Any key (Anthropic, `apikey_…`, `sk-or-…`, or the gateway token) is sent to a host other than the one the user configured, or written to a file or log, when the trigger is untrusted input.
  - Command execution on the user's machine triggered by model output, tool output, Jev responses, or fetched content. The `/jev` heredoc breakout is in this class, because model-written arguments reach the shell.
- **High.**
  - Credential sent to a host that untrusted input can choose (for example through a file an attacker can write, or a gateway upstream value that a request can influence).
  - Bypass of the display hook's UUID gate to change routing decisions, or to write journal records beyond the bounded annotation fields.
  - Prompts, tool output, or key values written to the journal or traces, contrary to the documented privacy promise.
  - Any file write outside the config directory driven by untrusted input.
- **Medium.**
  - Crash, hang, or unbounded memory use triggered by untrusted input (for example a Jev response body with no size cap, `client.ts:279`, or request bodies up to 64 MiB).
  - Unbounded disk growth triggered by untrusted input.
  - Jev or upstream URL accepted over plain `http:` when the value came from a file or environment an attacker can influence.
- **Low.**
  - Local-only denial of service, for example a local client that already holds the token and fills disk or ties up the gateway.
  - Terminal escape injection through model or tool output (`ui.ts:102-103`).
  - Local information exposure: the hook URL in child argv; the gateway token printed by standalone `jev-opus gateway`; raw Jev error text in driver-mode traces.
  - Plain `http:` Jev or upstream URL set by the operator.
  - Same-user processes reading the gateway token from the child environment. Such processes can already read `$CONFIG_DIR/.env`.

## Anything to leave alone

- Operator-set values: `JEV_BASE_URL`, `JEV_OPENROUTER_URL`, `JEV_GATEWAY_UPSTREAM`, `JEV_OPUS_ANTHROPIC_BASE_URL`, `JEV_OPUS_CLAUDE_PATH`, `JEV_OPUS_CONFIG_DIR`, and similar. Pointing these somewhere else is an operator choice.
- Documented opt-ins: `--yolo`, `--permission-mode bypassPermissions`, `--settings user`, `JEV_OPUS_INHERIT_CREDENTIALS=1`, `JEV_OPUS_EVALUATOR_CONTENT=full` (which sends prompts to Jev), and `JEV_OPUS_NARRATION=1`.
- Loopback HTTP between the gateway and Claude Code. TLS is not needed there.
- The standalone gateway printing its token to the operator's own terminal.
- The Anthropic credential being placed in the Claude child's environment. The child needs it.
- Jev answer quality and effort choices. These are not security properties.
- Dependency advisories with no reachable path from the code above.
