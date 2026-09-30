# Classifier implementation review — 2026-09-28

Reviewed the uncommitted changes against `c355fb3`. Keep the production fixes, restart correction, and audit additions. The regression fixtures address the observed incidents, but the classifier still needs correction before release: it can now classify a genuine masked failure as a success and clear its unresolved issue.

## Findings

### P1 — A passing summary can override another check's real failure

Location: `src/claude/describe.ts:77–85`, particularly the early success return at line 80.

The scan reduces all command output to one set of summaries and markers. Any zero-failure summary suppresses all marker-only failures, without proving that the summary belongs to the same check.

Reproduction:

```sh
npm test; npx tsc --noEmit 2>&1 | tail -5
```

```text
# pass 149
# fail 0
src/index.ts(1,1): error TS2304: Cannot find name foo.
```

The classifier returns `failed=false, suspect=false`. The compiler's exit status is masked by `tail`, so this is precisely a case where the text classifier must retain failure evidence. Reversing the command order has the same problem.

This was also reproduced with actual local commands: a passing `node --test` followed by TypeScript compiling an intentionally invalid assignment. The combined shell command exited 0; output contained both `# fail 0` and `error TS2322`; the classifier returned success.

Reducer impact was verified separately: first execute the same command with both test and compiler failures, then rerun with passing tests but the same compiler failure. Open issues go from 1 to 0, and the router reports `failing check now passes → release hold`.

Fix: a success summary must not exonerate unrelated check/error output. Preserve independent failure evidence, or classify conflicting evidence as uncertain when attribution is unavailable. Add both command-order permutations and the false-resolution sequence as regression tests.

### P2 — Mixing inspection with a silent check still creates false failures

Location: `src/claude/describe.ts:375–383`, combined with the marker handling at lines 81–86.

`commandKind()` promotes the entire shell script to `check` if any segment runs a check. That makes text from a source or historical-log read into current check evidence again.

Reproduction: `cat previous-test.log; npx tsc --noEmit`, where the file contains `FAIL src/date.test.ts` and TypeScript succeeds silently. The tool reports success, but the classifier reports `check-output` failure. `sed -n '1,40p' previous-test.log; ./scripts/check.sh` behaves the same way.

Fix: retain the distinction between inspection and execution in compound commands. A mixed command with unattributed marker text should not automatically create a durable correctness issue. Test mixed inspection/check commands with silent success, not only checks that print a passing summary. This and the P1 finding require compatible evidence-attribution rules; changing global precedence alone trades one bug for the other.

### P2 — Failed output comparisons are discarded as exploratory

Locations: `src/claude/describe.ts:282` and `src/router/state.ts:148`.

The new lookup list includes `cmp` and plain `diff`. When either is used as an acceptance check and returns a nonzero exit status, classification correctly sets `failed=true`, but the reducer then discards it as exploratory because `kind=lookup`.

Reproduction: `cmp expected.txt actual.txt` with different content and `is_error=true`. The router records no issue and moves MEDIUM → LOW with `exploring → -1`. Plain `diff expected.txt actual.txt` behaves identically. The previous reducer did not exempt these commands.

Fix: distinguish content inspection from comparisons whose exit status is the verification result. Keep harmless displayed source/diff text from triggering failures, but preserve explicit failed comparisons. Cover byte mismatches and comparison execution errors end to end through the reducer.

### P2 — Common shell wrappers hide recognized checks

Location: `src/claude/describe.ts:340`; shell heredoc handling also drops the executed body at lines 245–256.

Only an exact first `-c` argument is recursively classified. `bash -lc 'npm test 2>&1 | tail -5'` with `# fail 1` becomes `other`/suspect, although the nested command is a recognized test runner. With local routing, it opens no issue and reduces MEDIUM → LOW. The otherwise equivalent `bash -c` case correctly becomes a failed check and increases effort.

A shell heredoc running the same pipeline has the same gap: its executed shell commands are removed as if they were non-shell script content. Removing Python heredoc bodies is appropriate for shell classification; shell heredoc bodies need distinct handling.

Fix: support common shell option forms containing `-c` and shell-interpreted heredocs, with bounded recursion. Until supported, narrow the README's broad claim about heredoc/shell coverage. Retain the documented suspect-only treatment for genuinely unknown custom scripts.

## Independent validation

- All 161 tests pass; typechecking and build pass.
- Rebuilding `dist/` produces exactly the existing uncommitted generated contents.
- The new restart regression passes as part of the test suite.
- Reclassifying all 248 Bash results in the identified Proteus session against the baseline reproduces the reported counts: 28 old failures become OK, 3 become suspect-only, 11 remain failures, and 1 previously missed failure is detected.
- The hold audit reproduces 183 decisions with open reasoning issues and 36 distinct issue references across all local journals. `I-5061c7d9` appears in exactly 34 decisions. Decisions with open issues are not necessarily decisions where the issue actually prevented a downgrade.
- The additional counterexamples above run locally without model calls. They are outside the current regression suite.

Production source and tests were left unchanged during this review. This document is the only additional repository artifact from the implementation review; generated build output was verified unchanged.
