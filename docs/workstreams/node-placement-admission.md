# W08-A placement admission handoff

Wire schema/protocol version is 1. Unknown versions reject; the v0 checkpoint
refers to the interface milestone, not a permissive wire version.

The canonical `deviceIdentity` host reference is main or device. Device pins
include W07 worker installation, key and authorization revisions. Harness
installation IDs belong to HRT and must not be confused with worker installation
IDs. HRT runtime contract remains version 1. Native manager ownership must compare
host reference, original main installation and immutable binding hash.

`SavedNodePlacement` belongs to the immutable saved workflow node. Public Start
continues to accept version/configuration/location pins rather than runtime JSON.
The internal `RunPlacementAdmissionPort` loads those exact saved records and
obtains authenticated W07 destination and W09 materialization evidence outside
SQL/graph locks. The validation port must verify attestation signatures, host,
registration, root allowlist, canonical symlinks, directory identity, execute/read
and required write access. Passing unchecked worker JSON to this port violates
the contract. Destination revalidation is required before native submission.

`preparePlacement` verifies revisions, host, payload and CWD policy. The binding
hash freezes all accepted source/configuration/root/harness/credential-reference
pins. Filesystem identity includes canonical host, filesystem device and inode.
`insertAcceptedPlacements` persists every node on the same branded transaction
as accepted Run, canonical initialization and Start receipt. Its supplied fence
must perform SQL-only live grant/registration/root/configuration revision checks
both during insertion and before COMMIT. A saved placement without composition
fails closed. Replay returns the existing Run before preparation; the original
immutable placement evidence is read from `run_node_placements`.

Lazy occurrence dispatch derives only from accepted pins. `insertDispatchIntent`
uses the existing Run owner/session fence and transaction, checks persisted
placement, and persists an exact operation/attempt. SQL constraints correlate
canonical repeat execution, occurrence, technical attempt and input digest.
The caller must invoke this in execution admission's existing transaction and
publish wakeup only after a known COMMIT. Intent membership grants no native-entry
permission: retain the existing one-use native entry guard, live authorization
and on-host path checks. Dispatch claims/native owner grants are separate from
the persisted main scheduler session fence.

Migration 284301 is additive and intentionally rejects historical evidence
backfill: placement rows require a newly inserted Run in the same transaction;
new intents require that execution's admission transaction. Immutable rows have
update/delete/truncate guards. Integrate the migration index before enabling
placement admission. No migration invents placement, attestation or observation
for existing Runs. Read legacy missing evidence as `legacy_missing`; retain a
verified original main installation when one exists. Never use today's selected
computer to infer historical runner-local placement.

Shared files belong to the orchestrator/HRT owners. External patches are:
`w08-a-shared-contracts.patch` (export and saved node placement),
`w08-a-admission.patch` (Start seam), and `w08-a-runtime-context.patch` (HRT-B).
Production composition, W07 authenticated filesystem endpoint/W09 attestations,
owner-grant validation, worker submission/control and full HTTP/MCP denied/readback
checks are W08-C/B integration gates, not proved by this lane's unit fixtures.

Focused commands from the lane worktree:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts exec tsc -p tsconfig.build.json
corepack pnpm --filter @graphql/api exec tsc --noEmit
corepack pnpm --filter @graphql/api exec eslint src/modules/placement src/infrastructure/nodePlacementMigration.ts test/node-placement.test.ts test/node-placement-transaction.test.ts --max-warnings 0
corepack pnpm --filter @graphql/api exec vitest run test/node-placement.test.ts test/node-placement-transaction.test.ts --maxWorkers 1
```

Orchestrator integration must prove migration SQL, exact replay after saved edits,
concurrent save/registration/root drift, faults before and after Run/intent COMMIT,
canonical receipt/intent completeness, schedule/repeat/continuation compatibility
and native authorization. The real two-host bytes and process evidence gate,
including uncertain ACK recovery without replacement execution, remains required.
