# Improvement review — 2026-09-28

Reviewed v0.4.7 at `c355fb3`. The most useful next release would repair effort-state recovery and presentation, then make the existing audit and evaluation data easier to use. The shared router, deterministic fallback, journal, and transport separation are worth retaining; a rewrite is unnecessary.

Production follow-up: the user's latest Proteus Claude session exposed a higher-priority, observed routing problem: successful source inspection creates false unresolved failures and holds effort HIGH. See [the production session review](production-session-review-2026-09-28.md) and its linked evidence. Fix this alongside the restart defect before tuning effort thresholds or adding presentation features.

## Verified findings

### 1. P1 — Restart can leave a manual override active after automatic routing resumes

Location: `src/gateway/server.ts:538`, with the insertion decision at lines 457–460.

`restore()` prefers the last surviving **gateway insertion** over the ancestor's requested effort. A later client `/effort` statement can supersede that insertion. Restoring from only gateway insertions therefore reconstructs the wrong current effort.

Local HTTP reproduction:

1. Configure automatic bounds `low..low` and send a prompt with the client's initial `medium` statement. The gateway inserts `low`.
2. Send a tool-result turn with a new client `high` statement. The manual override correctly takes effect.
3. Restart the gateway with the same journal, then send a new human prompt. Automatic routing resumes and selects `low`.
4. The gateway restores current effort as `low`, decides no new insertion is needed, and forwards a transcript whose final effort statement is still `high`.

Observed output:

```json
{"selected":"low","forwardedEffort":"high","statements":["low","medium","low","high"]}
```

This lets the forwarded effort exceed the automatic ceiling on the new prompt while the status and audit report LOW. The manual HIGH on the earlier prompt is legitimate; retaining it after automatic routing resumes is the defect.

Fix: reconstruct effective effort in transcript order, including client statements and replayed insertions. Ensure resetting manual mode establishes the new automatic decision in the actual outgoing transcript. Cover restart and thread eviction, with manual statements both before and after the governed user turn.

### 2. P2 — Replay is skipped for tool-less side requests and token counting

Location: `src/gateway/server.ts:242–246`.

The gateway calls its transformation path only for `/v1/messages` requests with a nonempty tools array. Requests to `/v1/messages/count_tokens`, and side requests without tools, strip the model alias but omit prior gateway insertions and the accompanying beta header.

Local reproduction using the same original conversation prefix:

```json
{
  "originalStatements": ["low", "medium", "low"],
  "countStatements": ["medium"],
  "sideStatements": ["medium"]
}
```

The count endpoint receives a different transcript from the generation endpoint. A tool-less continuation also loses effort history, contrary to the README's statement that side requests retain the inserted prefix. The request mismatch is verified; its precise provider cache, thinking, and token-count effects were not measured.

Fix: separate replay from choosing a new effort. Replay valid ancestor insertions for eligible Jev-model conversations even when the request should not generate a new decision. Keep side queries and token counting from advancing controller state, creating dispatch attempts for generations, or changing UI state. Test the exact forwarded prefix and headers.

### 3. P2 — Status line reports stale Jev state after switching models

Location: `src/gateway/launch.ts:184–186`; model switching clears only inline display state at `src/gateway/server.ts:251`.

The status-line command consults the selected model only when there is no saved status file. Once the session has used Jev, selecting another model leaves that file in place and the command keeps showing its previous effort.

Local reproduction: route a Jev request, send a request for a non-Jev model, then invoke `statusline` with that model's ID. It prints:

```text
◆ Jev · LOW · refactor · local routing
```

Fix: check the currently selected model before rendering saved routing state. Clear or mark the session's persisted status inactive on a model switch. Cover switching away, switching back before a new decision, and old status files after restart.

## Useful functions to add

| Priority | Addition | Concrete user value | Implementation starting point |
| --- | --- | --- | --- |
| 1 | Audit summary and timeline | `jev-opus audit --since 24h --summary` shows effort distribution, evaluator latency, retries, failures, cache usage, and incomplete coverage. A session filter makes individual runs findable. | Build read-only projections over the existing journal. Add a privacy-preserving session lookup; current files use composite-key hashes. Keep observed usage separate from estimated cost. |
| 2 | Evaluation report and retained failure artifacts | Turn the existing fixed-medium/high/local/Jev results into a comparison of verified success, total observed cost, evaluator overhead, latency, and missing-cost coverage. Save verification output and diffs for failed trials. | Extend `evals/run.ts` and add a separate report command. Its current records omit verification output, and cleanup removes the trial worktree. Run paid comparisons only with explicit scope and budget. |
| 3 | Offline diagnostics | `jev-opus doctor --offline` checks configuration, Claude resolution/version, journal access, and gateway setup without making model calls. Make online probes a clearly identified option. | Factor the existing doctor checks into local and network phases. Return structured results with `--json`. |
| 4 | Driver interruption and limits | Expose an explicit cancellation method and time limit so a long task can stop cleanly while retaining partial accounting. | Thread an abort signal through routing and the SDK lifecycle; settle the pending `send()` and record incomplete usage. The current `close()` closes input and waits for the consumer rather than providing cancellation. |

Suggested sequence: fix finding 1, then findings 2 and 3; add the audit summary; improve the evaluation report before changing routing thresholds. Actual task comparisons are needed to establish whether adaptive routing saves resources at acceptable quality. Existing correctness tests cannot answer that question.

## Validation and scope

- All 149 existing tests passed.
- `npm run typecheck` passed.
- `npm run build` passed; regenerated `dist` matched the committed files.
- Findings were reproduced with a loopback fake upstream, temporary journals, and synthetic conversations. No paid model calls or user credentials were needed.
- Reviewed gateway/replay, journaling, routing policy/evidence, SDK session handling, CLI, evaluator client, and evaluation runner. This is a focused code review, not a complete security audit or live provider compatibility test.
- Production source and tests were left unchanged. This report records the review and proposed next work.
