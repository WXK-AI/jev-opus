# jev-opus

**Claude Opus 5.5 with the effort level re-decided at every step, without breaking the prompt cache.**

[![npm](https://img.shields.io/npm/v/jev-opus)](https://www.npmjs.com/package/jev-opus) [![ci](https://github.com/WXK-AI/jev-opus/actions/workflows/ci.yml/badge.svg)](https://github.com/WXK-AI/jev-opus/actions/workflows/ci.yml)

```bash
npm install -g jev-opus && jev-opus init && jev-opus claude
```

<p align="center"><img src="assets/demo.svg" width="860" alt="Effort switches medium → low → high → low inside one Claude Code prompt while the prompt cache keeps growing"></p>

jev-opus runs Claude Code on `claude-opus-5-5`, either your normal interactive `claude` with an "Opus 5.5 · Jev" entry in `/model`, or a session it drives itself. The [TypeSafe Jev](https://typesafe.ai) System-1 reflex picks the effort level when a prompt arrives, then again after every tool batch, before Claude's next API call. Reading files runs at `low`. A failing test raises the next step to `high`. Once tests pass, it drops back down. All of this happens inside one prompt.

```
◆ jev │ task debugging · difficulty 1.3/4 · stakes 0.43 → MEDIUM
  ▸ Bash cat dates.js …
◆ jev │ next: exploring · step 1.1/4 · stuck 0.07    → MEDIUM ⇒ LOW
  ▸ Bash npm test …
◆ jev │ next: diagnosing · step 1.1/4 · stuck 0.09   → LOW ⇒ HIGH
  ▸ Bash sed -i … dates.js
◆ jev │ next: verifying · step 0.8/4 · stuck 0.06    → stays high (holding after escalation)
✓ done in 16.4s · 4 API calls · $0.1229 Claude + $0.00014 Jev
  effort path: medium → low → high×2  (2 mid-prompt changes)
  cache: 84% of input from cache — reads grew every call: 8.1k → 14.0k → 17.2k → 18.7k
```

## Why the cache survives

Normally, changing `effort` between requests changes the request prefix, which throws away the prompt cache. Opus 5.5 also accepts effort as a **per-message statement** inside the conversation. jev-opus only ever changes effort that way, and it keeps every statement in place on later requests, so the history the model saw never changes. Two modes, same guarantee:

- **`jev-opus claude` (gateway):** your normal Claude Code → local gateway → Jev decides → effort statement inserted before the turn it governs → Anthropic API.
- **`jev-opus "task"` (driver):** runs Claude Code headless via the Agent SDK. After each tool batch, a hook calls `applyFlagSettings({ effortLevel })`, which Claude Code sends as a per-turn statement.

## Install

Requirements:
- Node ≥ 22.18
- [Claude Code](https://code.claude.com) 2.1.280 or newer, logged in (`claude auth login`)
- a Jev key, either a [TypeSafe](https://typesafe.ai) key (`apikey_…`) or an [OpenRouter](https://openrouter.ai/keys) key (`sk-or-…`), which reaches the same Jev model through TypeSafe. Without one, jev-opus still works, using local heuristics.

```bash
npm install -g jev-opus      # or run anything without installing: npx jev-opus …
jev-opus init       # writes ~/.config/jev-opus/.env and asks for your Jev key
jev-opus doctor     # checks Claude Code, your credential, Jev, and a real Opus 5.5 call
```

## Use it in your normal Claude Code: "Opus 5.5 · Jev" in `/model`

```bash
jev-opus claude                 # any `claude` arguments work: jev-opus claude -c, jev-opus claude -p "…"
```

This opens the regular interactive Claude Code, the same interface, tools and approvals. It adds a model entry, **Opus 5.5 · Jev**, and selects it for you. While that model is selected, Jev re-picks the effort before every API call. Pick any other model in `/model` and requests pass through untouched. Each assistant text message gets an **inline effort badge**, so you can see the selected effort beside the work it governs:

```text
◆ Jev · MEDIUM → LOW · exploring

I’ll read the parser and its tests.

◆ Jev · LOW → HIGH · diagnosing

The failure comes from how leap years are handled.

◆ Jev · HIGH · verifying

I’ll check the fix against the remaining cases.
```

The transition arrow appears on the first badge for a decision; later messages repeat the current level. A response containing only tool calls gets one inline notice before its tools run. Manual `/effort` changes are labelled `manual override`; local decisions are labelled `local routing`. The status line also shows Jev's latest choice:

```
◆ Jev low → HIGH · diagnosing
```

The badges use Claude Code's [MessageDisplay hook](https://code.claude.com/docs/en/hooks#messagedisplay). They change the live display only: they add no model tokens, do not rewrite the model conversation, and are not saved into exported or resumed historical messages. Hook requests stay on the local gateway and make no additional Jev calls. The badge reports the gateway's selected effort, not independent confirmation of the provider's effective effort.

`jev-opus claude` enables badges automatically and merges the hooks with any `--settings` JSON or file you supply. It preserves your custom status line. Set `JEV_OPUS_NO_INLINE_EFFORT=1` to disable badges, or `JEV_OPUS_NO_STATUSLINE=1` to omit the Jev status line. Other `MessageDisplay` hooks run in parallel and can compete to replace displayed text; use one display formatter at a time. Claude Code's safe mode or disabled hooks also disable inline badges.

**How it works:** `jev-opus claude` starts a small local gateway and points Claude Code at it (`ANTHROPIC_BASE_URL`, an officially supported setup that keeps your claude.ai login). For each request on the Jev model, the gateway asks Jev and inserts a **per-message effort statement** at the turn it governs. It replays every earlier insertion byte-identically on later requests, so the cached prefix and preserved-thinking blocks stay valid. Verified live: effort went medium → low → high → high → low inside one prompt, while cache reads grew on every call (24.5k → 29.9k → 30.0k → 31.4k → 32.3k).

- **Manual changes win.** Running `/effort` yourself pauses Jev until your next prompt.
- **Subagents** are routed as their own threads.
- **Short side requests without tools** (titles, summaries) are never routed.

### Other Claude Code surfaces

Start a long-running gateway, then point the surface at it:

```bash
jev-opus gateway                # http://127.0.0.1:47821, prints the env to use; decisions logged to ~/.config/jev-opus/gateway.log
```

The standalone gateway also prints the hook settings for inline badges. Merge those into the client's Claude Code settings while that gateway is running. Restarting the gateway generates a new hook URL; `jev-opus claude` wires this up automatically on each launch.

| Surface | How | Works with a claude.ai subscription? |
| --- | --- | --- |
| Terminal `claude` | `jev-opus claude`, or export the printed env before `claude` | **Yes** (tested) |
| VS Code extension | put the printed env in `claudeCode.environmentVariables` | Yes (same mechanism; not yet tested) |
| JetBrains plugin, Agent SDK apps | set the printed env for the process | Yes (same mechanism; not yet tested) |
| Claude desktop app, Code tab | The app ignores `ANTHROPIC_BASE_URL`. It only uses gateways in its "Claude Desktop on 3P" mode (Developer → Configure Third-Party Inference → Gateway), which replaces your claude.ai account with an **Anthropic API key**. | **No.** Use `jev-opus claude` in the app's terminal panel instead. |
| claude.ai web, mobile, cloud sessions | not routable | No |

`JEV_GATEWAY_DEBUG=1` logs each request's model and message layout (never credentials).

## Or let jev-opus drive the whole session

```bash
jev-opus "fix the failing date tests"            # one prompt in the current directory
jev-opus                                          # its own interactive session: /pin high · /auto · /bounds low medium · /status
jev-opus --route-only "design our billing queue"  # see Jev's decision; no Claude call
jev-opus -v -w ../repo "…"                        # routing reasons, every tool result, per-call effort + cache
```

This mode runs Claude Code headless through the Agent SDK. It switches effort with `applyFlagSettings` from a hook that runs after every tool batch.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--min` / `--max` | `low` / `high` | effort range Jev may use. Pass `--max max` to allow `xhigh` and `max` (`JEV_OPUS_MIN_EFFORT` / `JEV_OPUS_MAX_EFFORT` for every mode) |
| `--effort <level>` | none | pin one level; no routing |
| `--no-jev` | off | local heuristics only |
| `--permission-mode` | `acceptEdits` | anything not auto-allowed is asked for in the terminal; `--yolo` bypasses all prompts |
| `--settings` | `project,local` | Claude Code settings sources to load; add `user` to load `~/.claude/settings.json` |
| `--json` | off | full report: decisions, effort per API call, usage |

Every run writes a JSONL trace to `~/.config/jev-opus/traces/`.

## Claude Code plugin

The repo is also a plugin marketplace. In Claude Code (CLI or desktop app):

```
/plugin marketplace add WXK-AI/jev-opus
/plugin install jev-opus@jev-opus
```

- `/jev-opus:jev <task>` hands the task to a Jev-steered Opus 5.5 run and reports back the result, the effort path and the cache stats. This works inside any chat, desktop app included.
- `/jev-opus:jev-route <task>` shows the effort Jev would pick, and why.

A plugin can't retune the chat it runs in. Claude Code hooks can't set effort, and the desktop app refuses to let a session change its own effort. For that, use `jev-opus claude`.

## How the effort is chosen

**At task start** (`src/router/policy.ts → taskEffort`), from Jev's difficulty score (0 to 4):

- **Base level:** below 1.25 → `low`; below 2.25 → `medium`; below 3.1 → `high`; above that → `xhigh`.
- **Task-type limits:** chat and factual questions cap at `medium`; writing and small code changes cap at `high`.
- **Floors:** debugging, architecture, math and feature work start at `medium` or above, unless the task is genuinely trivial.
- **High stakes** raise the level by one, to at least `high`.
- **`max`** only for extreme, critical work.

**After each tool batch** (`stepTarget`):

| Phase | Adjustment from the task's level |
| --- | --- |
| exploring | −1 |
| implementing | none |
| diagnosing | +1 |
| verifying | −1 |
| finishing | −1, capped at `medium` |

- **A hard next step** goes to at least `high`.
- **Failed tool calls** add one level.
- **Stuck** (repeated failures, or Jev judges the agent stuck) jumps up at least two levels.
- **Floor:** a step never drops more than two levels below the task's level.

**Anti-flapping:** raises apply immediately. After a raise, the level holds for one more step, then steps down one level at a time.

**If Jev is unreachable,** routing falls back to deterministic heuristics (`src/router/heuristics.ts`). A Jev outage never stops a run.

## Credentials and isolation

The Claude Code child process never inherits a parent session's `ANTHROPIC_*` / `CLAUDE_*` variables. That matters when jev-opus is launched from inside Claude Code: without this, it would reuse the parent's token and its pinned `CLAUDE_CODE_EFFORT_LEVEL`. The child gets only:
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from the jev-opus config, or
- your `claude` login.

The child also skips `~/.claude/settings.json` by default, so a proxy configured there can't redirect it, and your claude.ai connectors aren't loaded.

## Library

```ts
import { JevOpusSession, EffortRouter, JevClient, childEnv } from 'jev-opus';

const router = new EffortRouter({ jev: new JevClient(), bounds: { min: 'low', max: 'high' } });
const session = new JevOpusSession({
  router, cwd: process.cwd(), model: 'claude-opus-5-5', env: childEnv().env,
  permissionMode: 'acceptEdits', settingSources: ['project', 'local'],
});
const report = await session.send('fix the failing tests');
console.log(report.callEfforts, report.usage);
await session.close();
```

## Development

```bash
git clone https://github.com/WXK-AI/jev-opus && cd jev-opus && npm install
node src/cli.ts doctor      # runs the TypeScript directly (Node ≥ 22.18)
npm test                    # offline tests, including a scripted fake Claude Code that fires the real hooks
npm run typecheck && npm run build
npm run validate:plugin     # needs the claude CLI
```

Releasing: bump `version` in `package.json` and `plugin/.claude-plugin/plugin.json`, then `npm run build`, commit, and push a matching tag (`git tag v0.3.0 && git push --tags`). The release workflow tests, publishes to npm with provenance, and creates the GitHub release.

Inspired by [miuuyy/Astra-Ares](https://github.com/miuuyy/Astra-Ares), which brings Jev-chosen reasoning effort to Codex through a patched Codex build. jev-opus gets the same model-picker experience in Claude Code without patching it, through the supported gateway setup.

MIT © WXK-AI. Not affiliated with Anthropic, TypeSafe, or Astra-Ares.
