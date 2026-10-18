# Selected TS reference qualification

The authenticated Foreman CI request uses the existing `integration` suite and one actual file:

`apps/api/test/conformance-ts-reference.integration.test.ts`

Select it through the public `files` field. The controller chooses the explicit remote target. There is no new MCP target, scenario, command, host or profile parameter. `scripts/ci-native-selectors.json` binds this adapter to the committed `ts-reference-selection.json` integration plan.

The affected request's optional `conformanceTarget` is a fork source contract. Its default is `go`; existing `conformanceTsRequired: true` still means Go followed by TS comparison. An explicit `conformanceTarget: "ts"` requires exact scenario IDs, `conformanceTsRequired: false` and no selected Go work. This route selects only:

- `streams.operator.native-order` — A1
- `workflow.work-handoff-accepted-return` — E
- `workflow.native-input-resume-user-http` — E
- `workflow.native-input-resume-operator-http` — E
- `workflow.native-input-resume-operator-mcp` — E
- `workflow.schedule-latest-save-native-admission` — E

The suite calls the existing launcher with `--target ts` and one `--scenario` argument per ID. Its full inventory is read only to validate this exact selection. No complete conformance run, Go binary preparation or Go test is selected. The existing affected gate requires all requested actual outcomes, nonzero execution and successful setup/cleanup; failed or absent cases remain failures. The existing native collector adopts per-scenario results and drops only the wrapper's success assertion. It does not convert wrapper success into a conformance case.

The bounded report keeps `scope.completeSelection: false`. Its full-conformance verdict remains failed because the rest of the inventory was not executed; the separate affected selection gate must pass. Do not broaden this request to make the full-conformance verdict pass.

## Source and runtime identity

The target runs the TS production in the tested checkout. The adapter verifies its API, worker, shared packages, MCP launcher, patches and installation configuration against the unchanged frozen reference `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`. `ts-reference-inputs.json` records those exact frozen Git objects. The root package runtime fields remain frozen. Removing only the added conformance importer from the lockfile and the conformance package entry from workspace configuration must reproduce the original frozen objects. A changed or dirty protected input fails before launching scenarios.

The candidate harness checkout is not described as the frozen whole repository. `ts-reference-source.json` in the native session records its actual checkout directory, commit and tree, the separately verified frozen production inputs, the harness tree, the selected scenario IDs, and the selected manifest/plan/source identities. Generated contracts come from the affected compiler dependency closure, including the TS server and public credential CLI exports.

`native-input.json` is written before the selected adapter's routing environment is sanitized. It records the tested checkout and, when supplied, `CI_SELECTION_COMMIT` as **transportSnapshotCommit**. On cloud CI that value is an intermediate snapshot; it is not the original fork source commit. The terminal must join these emitted facts to the actual authenticated CI ticket's `run.provenance.sourceCommit`, `workflowCommit` and `workflowRef`. Neither a branch name nor a shortened snapshot message supplies that missing original source identity.

Every scenario still receives the existing fresh PostgreSQL cluster, random API/device ports, fresh HOME/state and test worker pairing. The route does not contact an installed app or existing paired worker. The outer and inner suite runtimes retain their existing owned cleanup behavior. Source/native metadata remains in the native report session for CI artifact collection after runtime cleanup.

## Affected verification

All execution is through Foreman CI MCP under the terminal controller. Local or Web execution of tests, compilers, linters, database setup or product runtime is prohibited for this slice. Static file/Git/hash/archive inspection is separate from runtime qualification.

The new public regression files are:

- `scripts/ci-conformance-target.test.mjs` — explicit target acceptance, native kind binding, normal comparison controls, rejected mixed scope, and reached TS runtime export planning.
- `scripts/ci-conformance-target-suite.test.mjs` — synthetic process/report fixtures covering TS-only command routing, fixture outcome fields, failure, zero execution and setup failure.
- `scripts/ci-native-input-provenance.test.mjs` — a synthetic native execution that publishes distinct observed checkout and transport snapshot provenance.

Run these exact files through retained unit-file selection, plus the affected existing `scripts/ci-conformance-scoped-suite.test.mjs` controls. The suite fixtures are tooling regression evidence and never count as the six native scenarios. The old-source witnesses use the exact new regression files with unchanged pre-fix production: public contract acceptance and export-plan assertions fail behaviorally; the provenance witness completes its old synthetic native action before failing the missing receipt assertion. Import, compilation or setup failures cannot substitute for these behavioral reds.

The six immutable correction roots to lint/typecheck separately are:

- `conformance/src/harnesses/nativeCodex.ts`
- `conformance/src/harnesses/setup.test.ts`
- `conformance/src/harnesses/setup.ts`
- `conformance/src/scenarios/streams/operatorTurnAcceptance.test.ts`
- `conformance/src/scenarios/streams/operatorTurnState.ts`
- `conformance/src/scenarios/workflows/handoff.ts`

Do not select their twelve helper tests for another unit execution; the controller owns that existing qualification. Public script lint/typecheck dispatch and explicit placement for retained source checks are limited by the deployed CI contract. The terminal plan must mark unavailable exact source-check routes HELD/UNRUN; it must not invent MCP fields, wrap a broad suite or modify deployment/fleet settings. The integration adapter itself is parsed and exercised by the selected native integration run.

All runtime qualification remains UNRUN until actual terminal CI tickets and results are supplied. This is a bounded Q-CONF continuation, not complete conformance coverage or final lane completion.
