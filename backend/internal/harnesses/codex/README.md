# Native Codex boundary — first GO L-H increment

This package supplies the first Codex client/types increment from NIM-2906:
typed native commands and a newline-delimited JSON-RPC transport. It does not
register HTTP or MCP routes, launch an installed provider, read accounts, or
claim that a provider installation has been qualified. The composition root,
shared generated domain contracts, and access implementation remain with I.

## Behavior and ports

`NewTransport` takes explicitly owned stdio and a required `Protocol` validation
port. `Start` performs the native initialize/initialized handshake.
`StartThread`, `StartTurn`, `InterruptTurn`, and `ListModels` forward generated
native parameter types. `Request` exposes the same boundary for the remaining
native methods. Callers supply sandbox and approval settings; this package
does not choose or widen them.

Responses retain their native operation identity across concurrent requests.
Native rejection is definite. Cancellation, timeout, malformed responses, or
transport failure after a write attempt remain uncertain and are not replayed.
Late responses can reconcile those operations through the supplied callback.
Read-only reconciliation commands without a callback do not consume retained
uncertainty slots. Both native frames and unresolved operations are bounded.

Queued requests recheck caller cancellation before marking a write submitted.
Their context and completion signals release queued goroutines. Callback
delivery reports a definite failure before any write attempt and uncertainty
after an attempt. Write completion alone is not provider acceptance evidence.

Native notifications, server requests, responses, and callback answers pass
through the required protocol validator. Known secrets are removed from
native JSON keys, values, and embedded JSON string literals before dispatch.
Public errors use fixed messages; native error text is separate diagnostic data.

Notification and request callbacks run in native input order. They must return
promptly. A callback may call `Respond`; it must enqueue any new command whose
answer needs further input rather than synchronously waiting in that callback.
Closing each supplied endpoint must unblock pending I/O. `Close` fences the
transport and retries failed endpoint cleanup on the next explicit call; it
does not establish process exit or guardian cleanup evidence.

## Generated native types

`protocol/types.gen.go` is generated from the captured native Codex schema at
frozen reference `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`, with method selection
from that reference's `scripts/generate-codex-method-types.mjs`. The capture
identifies `codex-cli 0.154.0`. Native unions retain their JSON payloads, and
`Optional[T]` preserves omitted, null, false, and zero values on the wire.
These are native protocol types, not copied Foreman domain contracts.

Source generation accepts explicit retained inputs:

```text
python backend/internal/harnesses/codex/protocol/generate_types.py \
  --schema <frozen-reference>/apps/api/test/fixtures/codex-protocol.schemas.json \
  --method-source <frozen-reference>/scripts/generate-codex-method-types.mjs \
  --output backend/internal/harnesses/codex/protocol/types.gen.go
```

The generator checks the captured input digests before writing source. Those
checks are provenance for reproducible source generation. They are not runtime
qualification, schema validation, or a substitute for the actual installation's
emitted schema. Production admission must supply that validation through
`Protocol`; the injected validator in the tests is only a fixture.

## Affected verification — terminal Foreman CI only

The author has not run formatting, builds, vet, lint, type checks, unit tests,
integration tests, or conformance. The retained ZIP contains a pre-fix candidate
and unchanged public cancellation regression tests for terminal red evidence.
No result is a CI pass until the controller records its actual ticket and output.

Request only these affected packages and named tests in an isolated CI checkout:

```text
# From backend, through terminal-dispatched Foreman CI:
go build ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go vet ./internal/harnesses/codex ./internal/harnesses/codex/protocol
staticcheck ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go test -count=1 ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go test -race -count=1 -run '^TestTransport(CorrelatesOutOfOrderResponses|CancellationDuringValidationSendsNothing|QueuedRequestCancellationSendsNothing|CanceledResponseBeforeWriteIsDefinite|ResponseCancellationAfterWriteIsUncertain|CancellationReconcilesLateResponseWithoutReplay|InvalidResponseRetainsLateReconciliation)$' ./internal/harnesses/codex
go test -tags=integration -count=1 -run '^TestScriptedAppServerSessionAndTurn$' ./internal/harnesses/codex
```

Formatting selection is the explicit changed Go-file manifest, including the
generated native types. The generator is source production, not a formatting
wrapper. The Node integration test copies the pinned repository fake app-server
to an owned temporary directory and uses isolated HOME, CODEX_HOME, state, and
temporary paths. It needs Node from the CI environment. No DB, port, worker
pairing, installed provider, or credentials are required for this increment.

The exact existing Q-CONF scenario for subsequent Codex facade integration is
`harness.codex-configuration-check`. This standalone package does not wire its
route, so that scenario is pending shared contracts, qualification, and
composition. Q-CONF owns the missing native transport correlation, framing,
callback delivery, cancellation, and late reconciliation scenarios; do not
invent IDs or edit expectations in this lane. Do not run a full conformance or
backend suite for this development increment.

## Remaining lane work

Installed-binary protocol acquisition and qualification, domain session mapping,
permission/MCP configuration, provider-account selection, and guardian process
ownership need their existing TypeScript ports and shared generated contracts.
The current runtime skeleton intentionally lacks that shared contract export
and concrete access implementation. This package's explicit low-level ports
allow fake app-server work while those foundations are supplied by their owners.
No execution-semantics fallback or admission receipt is introduced here.
