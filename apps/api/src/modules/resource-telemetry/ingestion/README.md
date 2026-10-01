# W11-B owner handoff (NIM-2855)

## 2026-10-01 authenticated carrier continuation

`carrier.ts` exports `mainResourceTelemetryExtension` (Main client),
`startRemoteTelemetrySession({service,binding,signal,request})` and
`createWorkerResourceTelemetryExtension({signal,currentBinding,createCollector})` (worker server).
The request function must be W07's captured `resource-telemetry` request for the exact supplied binding.
The Main loop issues a challenge, accepts the bounded response through the existing service, and skips
missed ticks. Worker initialization consumes A's `createPassiveLinuxResourceCollector` with the actual
registry and native-scope projection. Its collector uses connection/application lifetime rather than
individual request lifetime; a changed authenticated collector identity closes and joins the old sampler.
Both returned owners expose `close()`; Main also exposes `completion`, which the composition owner observes.
Ordinary transport loss stops requests while preserving authorized offline last-known state; live revocation
checks and a new authenticated handshake fence prior callbacks and generations.

The negotiated extension needs `mainCanRequest`; worker push is absent. The production authority direction
check now matches this request/response carrier. Five focused carrier cases include real W07 channel chunk
assembly/negotiation/revalidation, spoofed installation, stale callback, revoked authority and collector lifetime.
The combined carrier/authority/ingestion/HTTP-MCP adapter run passed 66 cases across four files.
Pinned heavy-job API `tsc --noEmit`, owned-file ESLint and `git diff --check` passed for this continuation.

Unfinished gates remain explicit: current device scope contract only contains `connect` and `heartbeat`,
so no explicit telemetry reporting grant is available and no registration was broadened. Root must settle
that contract before physical metrics qualification. Current production owned authority resolves genuine
local workflow captures only; remote workflow, role-specific conversations and CI require their original
accepted/native/lease/OCI projections. C/root exclusively own mounts and physical acceptance. No additional
role implementation, database, native, installation or security work was performed in this continuation.

Local/unpublished lane baseline: `0b23598c48a58e27151d891b4d4a9dcf183cbaff`.
CP1: `a195d043a298d186dcd5953bc816cdc2e9f7c371`; first lint/coverage correction: `f1db825a`.
The final lane commit includes subsequent wire bounds/source-role validation and ingestion/read adapters.

Read-only Linear source pins on 2026-10-01: parent NIM-2853 (`8a03abca-56b4-404e-aa5d-a0142c44df21`),
B NIM-2855 (`8d8aca28-9406-42b7-ba66-a949d4b7fd93`), A NIM-2854 (`58566787-5aa8-4fd0-85c2-476913d9f463`),
research document `3b98123f-5edc-40c7-b8a9-8c0885ccc6f1` / slug `8abde3d5de35`.
Read HRT NIM-2835/2836, W07 NIM-2821/2823, W08 NIM-2843/2844, CI NIM-2837/2838,
W05 NIM-2814, W12 NIM-2848 through Linear MCP; cross-checked `/tmp/graphql-workstream-20261001/w11-plan`.
Existing integrated leaf identities were inspected: deviceConnection/deviceIdentity, nodePlacement,
remoteExecution/remoteJobExecution, jobRuntime and harnessRegistry. Worktree checkpoints inspected:
W07 `3fa8ad2d`/`33d70824`, W08 `42109a51`/`e5a942c8`, CI `198bdfa4`/`a8b92d48`,
HRT `476206ab`/`1f242005`. These are source observations, not runtime qualification.

## Composition seams (owned by other lanes)

- HRT-03 constructs one `ResourceTelemetryService` per actual main runtime, injects the three
  authority ports and monotonic clock, registers HTTP/MCP, and joins `close()` before releasing
  the runtime owner. It exclusively owns production/server/factory/replay composition.
- W07 supplies `TrustedTelemetryContext` from its authenticated session, negotiated
  `resource-telemetry/v1`, and `resourceTelemetryExtension` on its existing chunked carrier.
  Remote installation maps to `binding.workerInstallationId`; local uses the real HRT main
  device/installation/boot/runtime epoch. No invented worker connection exists locally.
- Authenticated initialization/reset invokes `handshake(context, collectorGeneration)`;
  call `challenge()` at a two-second cadence, skip a null offer, and offer it to A's collector.
  Supply serialized **raw JSON** to `ingest(context, json, signal)`. Never accept context from
  that JSON or queue cached/offline captures. W07 retains control/Stop/heartbeat priority;
  B limits ingress to two pending frames and two outstanding challenges.
- Active authorization is distinct from online presence. The session authority must keep
  legitimate offline last-known reads possible while denying revoked registration/key/main/
  authorization/runtime generations. Revocation must call `revoke(context)` synchronously
  to fence callbacks and clear cache, in addition to live authority checks.
- HRT/W08/CI supply passive `TelemetryOwnershipAuthority.resolve` over existing exact lease,
  accepted execution/attempt/operation/binding hash/grant epoch and observed-host facts.
  Conversation leases have their own role authority. CI uses its genuine subject variant.
  Resolve must reject retired/revoked attempts even after reconnect. Private sharedOwners are
  authorization inputs only, never wire fields. Ownership transitions must be reflected live.
- `TelemetryReadAuthority` must resolve live principal/delegation and exact resource grants.
  Whole-computer telemetry requires an explicit device policy grant; a workspace/Run/Agent
  grant is insufficient. Owned workflow, conversation and CI grants remain separate. Check
  every co-owner before returning shared values; errors fail closed. This lane does not invent
  a new grant ledger or broaden the existing grants. Root must settle the actual device-policy
  producer before production registration; a permissive fake authority is never production wiring.
- Register `registerResourceTelemetryRoutes` below existing HTTP authentication and
  `registerResourceTelemetryTools` only for an authenticated Operator context, using the SAME
  service and denial audit. The POST read route's schema is read-only; normal browser origin
  protections still apply. Generic route reauthorization currently imposes capabilities:read
  on unknown paths, so telemetry reads rely on authenticated requirePrincipal plus the live
  scoped read authority rather than borrowing that unrelated permission.
- Shared package exports/barrels and Operator capability/catalog/permission discovery are
  root-owned. Required exports: `./resource-telemetry`, `./resource-telemetry-fixtures`.
  W12's selector projection must expose trusted current boot/runtime/collector generation before a first read; older DevicePresence alone does not contain collectorGeneration. Never synthesize it. Tool `resource_telemetry_read` remains a passive snapshot. Promise/AsyncIterable authorized
  `changes` is provided to presentation/HTTP stream composition; no collector starts on read.

## Deterministic evidence and remaining gates

Focused leaf/API tests use fake session/ownership/clock/authorization producers. Adapter parity
uses Fastify injection, bearer authentication and the real NodeStreamableHTTPServerTransport
at an isolated `/mcp` route; it reads retained samples through both adapters and denies callers
with no private last-known values. It does NOT exercise the fully composed production `/mcp`
with PostgreSQL policies. Root/HRT-03 own that integration gate and catalog/discovery wiring.

Commands from this worktree (pinned runtime):

```
corepack pnpm --filter @graphql/contracts exec tsc -p tsconfig.build.json
corepack pnpm --filter @graphql/contracts exec vitest run src/resourceTelemetry.test.ts --maxWorkers=1
corepack pnpm --filter @graphql/contracts exec eslint src/resourceTelemetry.ts src/resourceTelemetry.test.ts src/resourceTelemetryFixtures.ts --max-warnings 0
corepack pnpm --filter @graphql/api exec vitest run src/modules/resource-telemetry/ingestion/service.test.ts src/modules/resource-telemetry/readback/adapters.test.ts --maxWorkers=1
corepack pnpm --filter @graphql/api exec tsc --noEmit
corepack pnpm --filter @graphql/api exec eslint src/modules/resource-telemetry src/routes/resourceTelemetry.ts src/mcp/operator/resourceTelemetry.ts --max-warnings 0
```

Initial tests used temporary aliases to built contract dist while the root-owned exports were
pending. Subsequent checks use the canonical package exports; the current focused suite has 27 API cases and four contract cases. One expanded run stopped before
admission on shared heavy-job CI temp cleanup EACCES; a subsequent normal admission passed.
No permissions, security settings, scheduler, dependency, database, native helper, transport,
production factory, UI or physical service/pairing settings were changed by B.

The bounded in-memory latest/last-known cache is not durable history. B recomputes reported
counter/window arithmetic but cannot independently attest a remote kernel. DB authorization
races, production carrier/catalog/readback wiring, browser A/B/A acceptance, actual PC/laptop
and CI measurements, service/pairing/provider approvals, overhead qualification and physical
reboot remain orchestrator gates. No staged schema/unit result closes those gates.
