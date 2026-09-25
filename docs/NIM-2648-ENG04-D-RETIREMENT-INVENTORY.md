# NIM-2648 / ENG04-D — V3-only retirement inventory

Declared delta base: `c6c9e61e8a1991e7c8a67f2dd0ba82aa47fdf26a`
Observed PR head during preparation: `13a43e6eea2256c0cb44076a76dfd0227829886d` (independent code-line reporting only; untouched by this bundle).

This is a D regression/evidence inventory. It does not claim A/B/C production implementation or NIM-2649 live acceptance is complete.

## Compatibility-only D evidence retired in this replacement

- `eng04-start-dispatch.test.ts`: removes positive omitted-semantics / semantics-1 / semantics-2 Start dispatch. The current test accepts only explicit 3 and rejects retired/unknown tags.
- `eng04-start-management.test.ts`: removes the positive V2 admission test, all `oneShotAdmission`/Wave25 compatibility mocks and the mocked positive V3 Start receipt. It keeps denial/malformed-input checks only; real positive Start must come from production and NIM-2649.
- `eng04-repeat-postgres.test.ts`: removes the semantics-1 “legacy uniqueness” fixture and duplicate insert. Ordinary uniqueness is now exercised with a semantics-3 no-repeat Run plus the existing semantics-3 repeat cases.
- `eng04-projection-journal.test.ts`: removes the positive semantics-1/2 publication loop. The strong V3 journal replay/receipt/hole/retention/Stop assertions remain.
- `NIM-2648-ENG04-D-LIVE-SCENARIOS.md`: removes the old “open/run legacy 1/2” D10 acceptance requirement and replaces it with S3-01..05 plus retired-tag rejection with no side effects.

No historical ENG-03 evidence is edited or re-labelled.

## Useful assertions retained or ported to V3

- exact WorkflowVersion / Run / configuration / location pins;
- raw execution IDs, attempts, bound input bytes/digests and accepted result bytes/digests;
- command receipt replay and changed-payload conflict;
- authorization denial before work;
- occurrence identity, carry/decision ancestry and exact finite cap;
- unequal-depth selected joins and unselected branches;
- invalid accepted-result rejection;
- duplicate observation and ambiguous-COMMIT replay safety;
- technical retry vs business repetition vs whole-Run retry;
- Stop mid-occurrence and between occurrences;
- approval/native settlement ordering;
- provider-shaped identity checks;
- PostgreSQL retention/provenance/immutability checks;
- journal complete-batch, gap/reset, receipt, owner-fence and retention checks;
- V3 snapshot/complete-delta use of the same verified current cut;
- add-repeat then remove-repeat as ordinary V3 version changes.

## New reusable current-semantics evidence

`eng04-v3-unified-semantics.test.ts` defines positive S3 source/persistence candidates:

- S3-01 single and A → B, semantics 3, `repeat` absent;
- S3-02 parallel/all-required unequal-depth join, semantics 3, `repeat` absent;
- S3-03 conditional selected/unselected join, semantics 3, `repeat` absent;
- S3-04 supported approval topology, semantics 3, `repeat` absent;
- S3-05 real finite repeat with early and limit exits;
- add/remove repeat across three saved V3 versions;
- exact version/config/location/input/result pins and retired-tag rejection.

The positive no-repeat assertions are intentionally not skipped or weakened. They may fail at the declared base until A/B land.

`eng04-v3-retirement-source.test.ts` is an explicit gate-oriented source guard. It expects:

- no V3-to-V2 validation projection in the current V3 contract;
- optional `repeat` in the single V3 family;
- no V1/V2 Start union/admission/runtime branch;
- real production V3 Start publication composed;
- one shared HTTP/MCP Run Start service;
- mounted Board/current reader without semantics-1 fallback;
- repeat authoring as optional V3 state, not “saved semantics 2 vs 3”;
- snapshot/delta through the same verified V3 cut;
- compatibility-only migration fixtures retired before the gate.

## Current base blockers exposed, not repaired by D

These are source dependencies owned by A/B/C or shell integration. They are expected to make portions of the new smoke red on `c6c9e61...`:

- `packages/contracts/src/wave25/repeat.ts`: current V3 schema requires a nonempty repeat plan and projects through V2 validators.
- `packages/contracts/src/wave25/saved.ts` / `repeatAdmission.ts`: active saved/start unions still include old execution families; `ExecutableWorkflowV3Schema` is repeat-only.
- `apps/api/src/modules/runs/management.ts`: active V2/legacy Start branches remain and production V3 admission is called without the real publisher.
- `apps/api/src/modules/runs/engine.ts`: semantics-2 `executeOneShotRuntime` and V2 schema dispatch remain.
- `apps/api/src/production.ts`: the real `repeatStartPublication` exists but is not composed into public Start.
- `apps/web/src/features/workflow-board/client.ts`: compatible Run details and semantics-1 fallback remain.
- `apps/web/src/features/repeats/useRepeatAuthoring.ts`: saved semantics `2 | 3` fallback remains.

D does not restore a fallback or edit these production owners.

## Current compatibility-test blockers outside this focused D delta

The existing migration qualification lane still contains active V1/V2 compatibility fixtures:

- `apps/api/test/eng04-migration-postgres.test.ts` — `forward-v1`, `forward-v2`, `legacyReplay`, `legacy-key`, `rollback-legacy`, `scope-legacy` cases;
- `apps/api/test/eng04-migration-fixtures.ts` — `semantics: 1 | 2 | 3`, `installLegacy`, `legacyReplay` and conditional legacy record shapes;
- `apps/api/test/eng04-migration-static.test.ts` — asserts the `(1,2,3)` execution-semantics DB check as a positive compatibility property.

The new D retirement source guard marks those as gate blockers. They require retirement/reframing by their owner/orchestrator when A's current clean-schema contract lands. This bundle does not rewrite production migrations or falsify historical migration evidence.

## Allowed non-execution “version 1/2” references

The owner retirement is scoped to **execution semantics**, not every numeral or V1/V2 name. These may legitimately remain when independently versioned and still used:

- graph wire `protocolVersion: 1` and its schema/history receipts;
- MCP protocol/SDK versions;
- Codex/OpenCode provider/native protocol or provider versions;
- repeat `contractVersion: 1` and occurrence/decision schema version names while they remain the selected repeat sub-contract;
- normal saved WorkflowVersion revision numbers (`version: 1`, `2`, ...);
- migration registration numbers and historical evidence identifiers;
- historical ENG-03 documents/tests retained as history, provided they are not active current product dependencies or positive gate prerequisites.

## Gate handoff

NIM-2649 must run S3-01..05 through the actual mounted Board and equivalent authenticated HTTP/MCP services on one frozen repaired candidate, with real provider/native results. Source/unit/SQL-shaped tests, mocks and historical results cannot substitute for those positive journeys.
