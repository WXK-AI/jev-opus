# jev-opus

**Claude Opus 5.5 with the effort level re-decided at every step, without breaking the prompt cache.**

jev-opus drives Claude Code on `claude-opus-5-5`. The [TypeSafe Jev](https://typesafe.ai) System-1 reflex picks the effort level when a prompt arrives, then again after every tool batch, before Claude's next API call. Reading files runs at `low`. A failing test raises the next step to `high`. Once tests pass, it drops back down. All of this happens inside one prompt.

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

Normally, changing `effort` between requests changes the request prefix, which throws away the prompt cache. jev-opus changes effort mid-session through Claude Code's `applyFlagSettings({ effortLevel })`. Claude Code sends that change as a **per-turn** effort statement, not a top-level parameter, so the cached history stays valid. The hook that makes the switch runs *before* Claude's next request, so each change applies to the very next call.

```
prompt ──► Jev: task type · difficulty · stakes ──► starting effort
             │
             ▼
   Claude Code (claude-opus-5-5) ── tool batch ──► PostToolBatch hook
             ▲                                        │  Jev: next phase ·
             │        applyFlagSettings({effortLevel})│  step difficulty · stuck?
             └──────────── effort for next call ◄─────┘
```

## Install

Requirements:
- Node ≥ 22.18
- [Claude Code](https://code.claude.com) 2.1.280 or newer, logged in (`claude auth login`), or an `ANTHROPIC_API_KEY`
- a TypeSafe Jev API key. Without one, jev-opus still works, using local heuristics.

```bash
npm install -g https://github.com/WXK-AI/jev-opus/archive/refs/heads/main.tar.gz
# or run without installing: npx -y github:WXK-AI/jev-opus …
jev-opus init                           # writes ~/.config/jev-opus/.env and asks for your Jev key
jev-opus doctor                         # checks Claude Code, your credential, Jev, and a real Opus 5.5 call
```

## Use

```bash
jev-opus "fix the failing date tests"            # one prompt in the current directory
jev-opus                                          # interactive session: /pin high · /auto · /bounds low medium · /status
jev-opus --route-only "design our billing queue"  # see Jev's decision; no Claude call
jev-opus -v -w ../repo "…"                        # routing reasons, every tool result, per-call effort + cache
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--min` / `--max` | `low` / `high` | effort range Jev may use. Pass `--max max` to allow `xhigh` and `max` |
| `--effort <level>` | none | pin one level; no routing |
| `--no-jev` | off | local heuristics only |
| `--permission-mode` | `acceptEdits` | anything not auto-allowed is asked for in the terminal; `--yolo` bypasses all prompts |
| `--settings` | `project,local` | Claude Code settings sources to load; add `user` to load `~/.claude/settings.json` |
| `--json` | off | full report: decisions, effort per API call, usage |

Every run writes a JSONL trace to `~/.config/jev-opus/traces/` with every decision, plus the effort and cache usage of each API call.

## Claude Code plugin

The repo is also a plugin marketplace. In Claude Code (CLI or desktop app):

```
/plugin marketplace add WXK-AI/jev-opus
/plugin install jev-opus@jev-opus
```

This adds two skills:

- `/jev-opus:jev <task>` hands the task to a jev-opus run in the current project and reports back the result, the effort path and the cache stats.
- `/jev-opus:jev-route <task>` shows the effort Jev would pick, and why.

## Does it work in the Claude desktop app?

| Where | Works? |
| --- | --- |
| `jev-opus` in any terminal, including the desktop app's terminal panel | **Yes.** It is the full thing. |
| The plugin's `/jev-opus:jev` inside a desktop-app or CLI chat | **Yes.** It hands the task off to a jev-opus run, and Jev steers *that* run's effort. |
| Jev steering the effort of **the chat you are typing in** | **No.** Claude Code hooks cannot set effort, and the desktop app refuses to let a session change its own effort by design. jev-opus avoids both limits by owning the session it drives. |

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

MIT © WXK-AI. Not affiliated with Anthropic or TypeSafe.
