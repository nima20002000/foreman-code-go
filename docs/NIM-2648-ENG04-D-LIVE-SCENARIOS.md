# NIM-2648 / ENG04-D — reproducible real-app/native scenarios

These are instructions for the later NIM-2649 live testers. This Web lane did **not** run a hosted native provider, browser, shared app database, or production-like local app.

## Evidence rule

For every case record exact raw values, not UI labels or timing guesses:

- candidate commit SHA;
- workspace, workflow, workflow-version and Run IDs;
- repeat block ID, occurrence ID/index and occurrence `inputDigest`;
- raw harness execution ID, provider session/thread ID where exposed, attempt, and accepted result digest;
- decision ID, exit execution ID, decision reason/target, accepted-result digest;
- graph snapshot sequence and complete-delta sequence range;
- Stop/approval command ID + receipt/replay/conflict result where applicable.

Never treat a spinner, node color, process absence, or prose completion as native evidence.

## Scenario matrix

### D1 — one occurrence / early exit
Create a semantics-3 repeat with cap > 1. Make occurrence 1 exit with the declared early-exit outcome. Verify exactly one occurrence, no successor, exact raw exit execution ID and accepted-result digest, and persisted readback after refresh.

### D2 — multiple occurrences / predecessor binding
Drive at least two business occurrences. Verify occurrence 2 has a different raw occurrence ID, binding ID and input digest, and its `previous` points to occurrence 1's exact decision ID and accepted-result digest. Use distinct raw provider result IDs for the two accepted exit results.

### D3 — finite cap / exhaustion
Set cap 2 and return the repeat outcome twice. Verify occurrence 2 records `limit_exit`, uses the configured limit route, preserves the latest deliverable + remaining findings, and no occurrence 3 or launch is created.

### D4 — unequal-depth selected join
Use one fast selected branch and one deeper selected branch plus an unselected branch. Verify the join waits for both selected predecessors inside the same occurrence, the unselected branch is durably skipped, and occurrence-1 resolutions cannot satisfy occurrence 2.

### D5 — invalid result rejection
Return success-shaped provider output with an invalid repeat exit envelope (for example missing findings/null deliverable/prose-wrapped JSON). Verify no accepted result, decision, successor, route effect, or fake success is persisted.

### D6 — duplicate observation and command replay
Deliver the same terminal observation twice for the same raw execution ID, including one reconnect/replay. Verify one accepted result digest and one publication. Replay the same Start/Stop/edit command ID + payload and verify the exact stored receipt; replay the ID with a different payload and verify conflict.

### D7 — technical retry vs business repeat vs full-Run retry
Cause a retryable provider failure. Verify attempt 2 reuses the business occurrence and slot lineage. Then cause a business repeat and verify a new occurrence ID/index. Finally retry the whole Run and verify occurrence index restarts at 1 with no prior-Run ancestry.

### D8 — Stop mid-occurrence and between occurrences
For mid-occurrence Stop, capture already observed terminal bytes then Stop before acceptance; verify the terminal can remain observed but no accepted result/route/successor is committed. For between-occurrences Stop, capture the predecessor decision and durable successor input, then Stop; verify no next raw execution launches and predecessor IDs/digests remain unchanged.

### D9 — approval wait with sibling progress
Hold the repeat exit at approval settlement while an independently selected sibling completes. Verify the waiting exit is not accepted, sibling progress persists, and no repeat decision/successor appears until the exact approval/cleanup/boundary settlement clears.

### D10 — snapshot/complete-delta + compatibility
After multiple repeat facts, fetch one authoritative snapshot and a complete delta from the first sequence; reconstructed state must equal the snapshot cut. Refresh/reconnect and re-read persisted repeat state. Also open/run legacy semantics-1/2 fixtures to verify they remain readable/executable under their existing contracts and are not silently treated as semantics 3.

## PostgreSQL qualification

Use only the D-owned disposable PostgreSQL-17 database/role flow from `eng04-repeat-postgres.test.ts`; never point destructive tests at the shared app database. Run with the explicit `RUN_ENG04_REPEAT_POSTGRES=1` opt-in and an admin URL dedicated to test-object creation. Preserve the exact raw database evidence needed to tie occurrence/input/result/decision rows together.

## Provider pairing

Pair the matrix across available Codex/OpenCode combinations only within native capacity. A provider-shaped unit test is not proof of a real native session. Native evidence must come from the later live gate and must include the provider/session/raw execution identity actually observed there.

## Stored-execution and settlement evidence added by the correction

The corrected deterministic D harness now mirrors the production `readStoredRepeatExecution` row contract instead of rebuilding duplicated SQL columns from the mutable JSON record. The later live gate should capture the same invariants from real persisted rows when diagnosing any mismatch:

- `harness_executions`: raw execution ID, Run ID, workflow-node ID, agent ID, technical attempt and `repeat_occurrence_id` must agree with the immutable execution record;
- `run_repeat_executions`: slot ID, occurrence ID, technical attempt and durable identity must agree with the execution and slot;
- `run_repeat_slots`: canonical `input_json` and `input_digest` must agree byte-for-canonical-byte with the execution's bound input;
- a successful terminal may not pass repeat settlement merely because a test/provider reports success: its exact native-session reference and current durable closure generation must settle first;
- host/approval boundary settlement is checked only after that concrete native settlement proof. A missing successful-terminal session is `REPEAT_BOUNDARY_PENDING`, not an approval acknowledgement and not success.

The provider/session rows used by the deterministic unit harness are synthetic fixtures only. They are deliberately visible in assertions and are **not** native evidence. NIM-2649 must still obtain real Codex/OpenCode session/closure/approval evidence from the frozen candidate.
