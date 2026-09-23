---
name: jev-route
description: Show which Opus 5.5 effort level (low/medium/high) the TypeSafe Jev reflex would pick for a task, and why, without running it. Use when the user asks how hard Jev thinks a task is or what effort it would use.
argument-hint: <task to classify>
allowed-tools: Bash
---

# Ask Jev for an effort decision

This makes one Jev call and no Claude call:

```bash
npx -y github:WXK-AI/jev-opus --route-only <<'JEV_TASK'
$ARGUMENTS
JEV_TASK
```

Report the task type, difficulty, stakes, the chosen effort, and the reasons line. If `$ARGUMENTS` is empty, ask the user which task to classify.

If Jev isn't configured, the answer comes from local heuristics. Tell the user that, and mention `npx -y github:WXK-AI/jev-opus init`.
