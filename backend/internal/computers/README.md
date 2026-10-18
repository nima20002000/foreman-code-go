# Computer account observation cache

This increment ports the account observation cache behavior from
`apps/api/src/modules/computers/accounts.ts` at frozen TypeScript reference
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f` (source blob
`0f49fc9152192acc8fbef9373d371f05c9e46f68`). The matching source behavior
fixtures are in `apps/api/src/modules/computers/readCache.test.ts` (blob
`52d1bf31c7c37c015fb1741060c112ad21b9aed6`). It is a Step 1 computer-read
prerequisite, not the Step 2 maintenance cache or telemetry service.

`AccountObservationCache[T]` retains an opaque, already validated account
observation for thirty seconds after the probe finishes. Its internal key
contains only application installation identity and authorization revision;
the generated contract adapter must map Main's null revision to zero.
Concurrent reads share a pending probe even after thirty seconds and when a
caller requests refresh. An explicit refresh of a settled observation starts
a new probe and passes the refresh flag through. Invalidation deletes the
current entry and forces the next probe to refresh. Completion of an older
invalidated probe cannot replace or evict a newer entry.

A failed probe returns its original error to all pending callers and is
evicted for immediate retry. The service adapter must log the failure and
return null account data, matching the TypeScript service. A successful nil
observation, such as a device without the account capability, remains
cacheable. No error is silently converted into a cached success here.

One canceled waiter does not cancel a shared probe. The supplied probe owns
its bounded lifetime and service shutdown behavior; the frozen remote account
probe uses an independent 25-second timeout. The cache does not start a probe
for an already canceled waiter. Callers must treat returned values as
immutable. The adapter must use generated validation and response copying as
the source service does through `ComputerAccountsListSchema.parse`.

## Remaining Step 1 integration

No computer HTTP route, Operator MCP tool, authenticated account read service,
installation probe, or worker channel is registered by this cache. Every
service read, including a cache hit, must perform the original caller and live
principal checks and validate the requested target before it consults the
cache. The cache stores no authority. A cache test cannot establish revoked
principal handling or qualify a real installed worker.

At implementation base
`6988e479b5f4b0e755ffd623f3f3a8e64d806eef`, the tree contains no generated Go
contracts export or shared management principal/access implementation.
Integrator I owns those exports and composition; their Go import paths and
names have not been delivered. The exact source contract requirements for
the account read service are:

- `@foreman-code/contracts/management`: `ManagementPrincipal`,
  `ManagementAction`, and generated validation.
- `@foreman-code/contracts/computer-accounts`: `ComputerAccountsSchema`,
  `ComputerAccountsListSchema`, `ComputerAccountsListInputSchema`,
  `ComputerAccountsReadInputSchema`, and their generated types;
  `COMPUTER_ACCOUNTS_NAMESPACE` remains the wire namespace.
- `@foreman-code/contracts/device-identity`: `DeviceRegistrationSchema` and
  its generated type.
- `@foreman-code/contracts/device-resources`: `DeviceProvisioningTarget` and
  `sameDeviceProvisioningTarget` behavior.

The minimum shared access ports must carry the source behavior of
`access/http.requirePrincipal(request)`,
`access/liveManagementPrincipal.readLiveManagementPrincipal(sql, principalId)`,
and `access/policy.requireAuthorization(principal, action, resource)`.
Computer activity additionally uses `isAuthorized` for each scoped activity.
Denied reads use
`PostgresCommandCoordinator.recordDenied(principalId, source, action, targetKey)`;
the source permits an undefined principal ID and `http`, `mcp`, or `device`
origin. Suggested Go ports should take `context.Context`, the existing
`database.Querier`, generated principal/action types, and I's shared resource
interface corresponding to the source policy's `AuthorizedResource`.
Those are requested interfaces, not delivered Go API promises. This package
does not implement substitutes.

For future Operator registration the existing
`mcpserver.Registry.RegisterTool(*mcp.Tool, func(json.RawMessage) error,
mcp.ToolHandler)` requires the generated validator and I's shared access
implementation. The Operator tool remains `computer_accounts_list`, with an
optional target selecting a single installation. The HTTP routes remain
`GET /api/management/computers/accounts` and
`POST /api/management/computers/accounts/read`. I must attach these through
the shared composition root once the read services and generated types exist.

## Terminal-only affected verification request

Eleven new public function tests cover expiry, refresh forwarding, pending
deduplication, settlement freshness, invalidation, installation/revision
isolation, failure propagation and retry, cacheable unavailable results,
replacement safety, and waiter cancellation. They use opaque primitive
observations, controlled clocks and synchronization channels. They do not
read source text, inspect private cache fields, connect to hosts, open network
ports, install anything, or access real credentials or state.

All tests, build, vet, formatting, lint and runtime execution are reserved for
the terminal controller through Foreman CI MCP. Request only:

- Unit and race checks for `./internal/computers` with selector
  `^Test(Account|UnavailableAccount|StaleAccount|CanceledAccount)`.
- Build, vet and Staticcheck for `./internal/computers`.
- Formatting check for `backend/internal/computers/account_cache.go` and
  `backend/internal/computers/account_cache_test.go`.

No check ran in the Web authoring environment. These are new domain behavior
ports; a missing package on the old base is not meaningful behavioral-red
evidence. Do not repeat retained placement, devices or worker tests for this
independent cache. Full R acceptance remains open, and the authenticated
HTTP/MCP read and live-revocation scenarios await generated contracts, shared
access and composition.
