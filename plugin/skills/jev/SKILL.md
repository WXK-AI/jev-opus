---
name: jev
description: Hand a task to Claude Opus 5.5 running under jev-opus, where the TypeSafe Jev reflex re-picks the effort level (low/medium/high) before every step without breaking the prompt cache. Use when the user asks to run something "with jev", "through jev-opus", or wants effort tuned automatically per step.
argument-hint: <task to hand off>
allowed-tools: Bash
---

# Hand a task to jev-opus

jev-opus runs the task in a **separate** Claude Code process on `claude-opus-5-5`. Jev picks that session's effort when the task starts and again after every tool batch. It cannot change the effort of the session you are in now; that is by design in Claude Code.

## Run it

Pass the task through a quoted heredoc, so no quoting in the task can break the command. Run it from the user's project directory, **in the background** (tasks can take many minutes), and wait for it to finish:

```bash
npx -y jev-opus@latest --permission-mode auto -w "$PWD" <<'JEV_TASK'
$ARGUMENTS
JEV_TASK
```

If `$ARGUMENTS` is empty, ask the user what task to hand off instead of running anything.

Add flags only when the user asks for them: `--max <low|medium|high|xhigh|max>` raises the effort ceiling (default `high`); `--effort <level>` pins one level; `-v` shows every routing reason and per-call cache stats.

## Report back

When it finishes, tell the user:
- what jev-opus did, and its final answer, briefly and in your own words
- the `effort path:` line (for example `medium → low → high×2`) and the `cache:` line
- the cost line

Do not redo or re-verify the work yourself unless the user asks.

## If it fails

- `JEV_API_KEY not set`: the run still works, using local heuristics. Tell the user to run `npx -y jev-opus@latest init` to add their TypeSafe Jev key.
- `Not logged in`, or an authentication error: the user needs to run `claude auth login`, or set `ANTHROPIC_API_KEY` in `~/.config/jev-opus/.env`.
- Node older than 22.18: jev-opus needs Node ≥ 22.18.
- Anything else: show the error and suggest `npx -y jev-opus@latest doctor`.
