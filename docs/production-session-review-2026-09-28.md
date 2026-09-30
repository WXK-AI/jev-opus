# Proteus production session review — 2026-09-28

The production history changes the recommended priority: **fix false failure detection and the resulting HIGH holds first**, alongside the restart defect from the earlier review. Successful reads of source, diffs, and historical logs can currently create unresolved correctness failures. The router then faithfully holds effort for issues that do not exist.

## Session and evidence

Inspected Claude session `188f658e-59ae-443d-9a53-e6fd9273ccd3`, stored under the Proteus-v2 project history. The matching Jev records cover 2026-09-27 17:06:46 through 2026-09-28 06:12:51 UTC, or September 28, 01:06–14:12 in Malaysia.

The history includes verification and contract-workflow changes, review of delegated implementations, model-capability settings, evaluation reporting, Docker evaluations, and disk-space management. This is substantial engineering work; a high effort selection is not inherently wasteful. Downstream Proteus evaluation model usage is separate from the Claude/Jev gateway usage examined here.

Sources:

- Claude transcript: `/Users/xk/.claude/projects/-Volumes-Xk-Drive-Code-Harness-Proteus-v2/188f658e-59ae-443d-9a53-e6fd9273ccd3.jsonl`.
- Jev trace: `/Users/xk/.config/jev-opus/traces/2026-09-27T17-05-28-125Z-82744.jsonl`.
- Seven journal files joined by decision ID; exact paths and selected evidence locations are in [the structured evidence](production-session-evidence-2026-09-28.json).

The join found 268 decisions and 268 distinct attempts. Of those, 262 response IDs match the 262 distinct assistant message IDs in the transcript; block-level assistant records were not counted as separate calls. Six additional journal responses immediately precede the six automatic compaction boundaries. They appear to be compaction calls, but that identification is an inference because these response IDs are absent from the main transcript.

## Observed routing and transport

| Measurement | Observed value |
| --- | ---: |
| HIGH decisions | 181 / 268 (67.5%) |
| MEDIUM decisions | 58 / 268 (21.6%) |
| LOW decisions | 29 / 268 (10.8%) |
| Jev-sourced decisions | 74 |
| Local decisions without a Jev call | 192 |
| Heuristic fallback decisions | 2 |
| Recorded attempts with protocol completion | 268 |
| Attempts with incomplete recorded usage | 0 |
| Uncached input tokens | 14,903 |
| Cache-read input tokens | 36,056,232 |
| Cache-creation input tokens | 869,358 |
| Output tokens | 203,838 |
| Cache-read share of all recorded input tokens | 97.6% |
| Evaluator calls with recorded latency | 76 |
| Total recorded evaluator latency | 74.213 seconds |
| Evaluator latency p50 / p95 / maximum | 860 / 2,071 / 2,504 ms |
| Explicit unresolved-issue HIGH holds | 117 |

Usage is summed once per journal attempt. The cache share is cache reads divided by uncached input plus cache creation plus cache reads. It supports that caching was heavily used during this session; it does not establish optimal caching or savings relative to a fixed-effort run. Protocol completion does not establish task correctness, and selected effort does not measure actual reasoning.

## P1 — Source text is misclassified as a current execution failure

The production evidence shows false alarms at multiple points:

| Transcript tool/result lines | Actual operation and output | Jev decision | Persistence |
| --- | --- | --- | ---: |
| 114 / 116 | Inspect system information and print a Python source file whose documentation contains `uv: command not found`. Tool result is not an error. | `D-b264fc02`: MEDIUM → HIGH, failing checks | 8 decisions |
| 358 / 360 | Successful `git diff` displays the source of a failure-marker regular expression. | `D-b63f5ebe`: failing checks | 12 decisions |
| 388 / 390 | Successful `git diff` displays test fixtures containing `FAIL`. | `D-49002f4a`: failing checks | 7 decisions |
| 802 / 804 | Successful `grep`/`wc` source inspection prints the failure-marker definition. | `D-27dd7624`: MEDIUM → HIGH, failing checks | 34 decisions |
| 806 / 809 | Successful `cat`/`sed` source inspection prints the same failure-marker definition. | `D-2d909b2e`: failing checks | 33 decisions |
| 1037 / 1044 | An edit and verification command prints the regex, followed by `# pass 130` and `# fail 0`. | `D-cf6b780d`: MEDIUM → HIGH, failing checks | 7 decisions |
| 1047 / 1050 | Commit output includes the words `0 FAILED`; tests then report `# pass 130` and `# fail 0`. | `D-1bb6f9de`: failing checks | 6 decisions |

Persistence counts include the decision that creates each issue. The seven verified false issue fingerprints appear in 61 distinct decision snapshots. There are **17 HIGH hold decisions where every open reasoning issue belongs to this confirmed false-alarm set**. This does not mean all 181 HIGH selections were unnecessary, and it does not quantify achievable token or dollar savings.

There are also real test failures in the session, including failures hidden by shell pipelines whose final command exits successfully. Therefore `is_error: false` alone must not disable all textual failure detection.

### Why it happens

1. `src/claude/describe.ts:37–49` scans the first 4,000 characters of Bash output for broad failure words without knowing which command produced that text.
2. `src/gateway/transcript.ts:198–199` sets `failed` from that scan, then retains only the first 600 characters as the result evidence. This can also separate a detected marker from the evidence later used to classify it.
3. `src/router/state.ts:130` tries to exempt exploratory commands, but it operates on a clipped, flattened command description. `git diff` and `sed` are not recognized there, and shell quoting, assignments, and compound commands complicate the split.
4. The reducer records an unresolved issue for that command. A later successful test suite does not clear an issue assigned to a source-reading command. The policy then blocks de-escalation.

The issue reproduces against the current source without any model call:

```text
Bash command: git diff -- src/checks.ts
Tool result: is_error=false; content="const FAILURE_MARKER = /FAILED|FAIL/;"
Router classification: failed=true
Next effort: MEDIUM → HIGH, "failing checks → recovery effort"
Following npm test: passes
Next effort: HIGH, "1 unresolved issue(s) → hold high"
```

### Fix and acceptance criteria

- Preserve structured exit/error information and full command identity separately from the display summary.
- Classify the operation before treating arbitrary output text as failure evidence. Distinguish a current check execution from source inspection, quoted fixtures, and historical output.
- Keep textual detection for recognized checks and masked pipeline failures. For ambiguous mixed commands, record uncertainty rather than converting every occurrence of `FAIL` into a durable unresolved correctness issue.
- Normalize the failure evidence once, retaining the same marker/provenance through classification, fingerprinting, and routing. Do not detect from one window and classify from an unrelated shorter window.
- Store safe cause codes and originating tool IDs in the journal so an audit can explain which observation caused a hold without storing raw source or output.
- Add sanitized regression fixtures for the seven cases above, plus genuinely failing tests, output plumbing, mixed commands, and real environment failures. A passing unrelated suite must still leave a genuine failed suite unresolved.

## Revised feature priorities

1. **Production transcript regression replay.** Turn these sanitized observations into offline router fixtures. Exercise long sequences and compaction boundaries so false holds are visible beyond isolated unit tests.
2. **Explain the HIGH hold.** Add an audit view that lists the evidence type, originating tool ID, issue age, and resolution requirement for each hold. A session-level timeline should join all seven journal segments created across compactions.
3. **Separate main work from auxiliary requests.** Label compaction and other supported side-request types explicitly when reliable metadata is available. The six journal-only responses account for 36,611 observed output tokens; their role should be visible rather than inferred from timing.
4. **Retain the earlier correctness fixes.** Manual-override recovery after restart, replay on tool-less/token-count requests, and stale status after a model switch remain reproducible defects. This session does not establish that those specific scenarios happened in production.

After correctness is fixed, compare real tasks at fixed and adaptive effort. This session demonstrates transport and policy behavior, but has no counterfactual showing how the same work would perform at another effort.

## Limits and changes made

The live package version was not recorded in these decision events, so the deployed build identity cannot be established from them alone. The main false-positive mechanism was separately reproduced against the current checkout. The 149-test/typecheck/build results are from the preceding review; no production source changed in this follow-up. Only review documents and a structured evidence summary were added. No evaluation, agent, or Docker operation was launched or modified.
