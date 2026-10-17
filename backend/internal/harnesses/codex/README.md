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

The exact frozen schema is Git blob
`7de4646ea2657038e164609d9473c76c1be7c843`, 688,845 bytes, SHA-256
`d71ddf3bf5484f8de2799f7a4793c2e66808a9ec1a330e2307accb088ab5948a`.
It has no trailing newline. `protocol/native-inputs.json` records the capture
metadata and both input identities. Preserve these bytes when materializing the
fixture; adding a newline changes the input identity even though its JSON parses
to the same value.

Source generation runs only through terminal Foreman CI with explicit retained
inputs. Use an owned temporary output for reproduction:

```text
python backend/internal/harnesses/codex/protocol/generate_types.py \
  --schema <frozen-reference>/apps/api/test/fixtures/codex-protocol.schemas.json \
  --method-source <frozen-reference>/scripts/generate-codex-method-types.mjs \
  --output <owned-temporary-output>/types.gen.go
```

The generator checks the captured input digests before writing source. Those
checks are provenance for reproducible source generation. They are not runtime
qualification, schema validation, or a substitute for the actual installation's
emitted schema. Production admission must supply that validation through
`Protocol`; the injected validator in the tests is only a fixture.

## Current H-CODEX-002 generator verification — terminal Foreman CI only

The current generator repair request consists only of the two named public CLI
regressions below, followed on the corrected candidate by exact frozen-input
generation to an owned temporary output and comparison with checked-in
`protocol/types.gen.go`. Run the two cases on tests-only pre-fix candidate
`557d759decb4cdf6accdcac4c800a22cf6c95e12` and on the corrected candidate identified
by the repair ZIP's manifest. All execution is terminal-dispatched Foreman CI,
from the repository root:

```text
python backend/internal/harnesses/codex/protocol/generate_types_test.py -v GeneratorCLITests.test_frozen_native_inputs_generate_reproducibly GeneratorCLITests.test_added_newline_is_rejected_without_touching_output
```

They exercise exact-input acceptance, deterministic generation, rejection of an
added newline, and preservation of existing output on rejection. They do not
inspect generator source. The provenance repair changes only the generated
file's schema-digest comment; its generated declarations are retained. Terminal
CI must regenerate from the exact frozen inputs into an owned temporary output
and compare that artifact to `protocol/types.gen.go` before reporting
reproducibility. No generator or verification was run locally for the repair.

## Original c62/0ace transport verification — separate outstanding gates

This section retains the original H-CODEX-001 transport verification request for
candidate `c62fb50521c798969e7cb434b856841641297bee` and cancellation witness
`0ace55b2dc96fe898b82ce87c8fb2ba49b4d90d2`. These remain separate outstanding
original gates. They are not part of the current H-CODEX-002 generator repair
dispatch above.

The original `foreman-h-codex-c62fb505-reviewed.zip` contains that cancellation
witness and its unchanged public regression tests. The author has not run the
original formatting, build, vet, lint, typecheck, unit, integration or conformance
checks. No result is a CI pass until the controller records its actual ticket
and output.

For a separate original-transport CI dispatch, the retained affected commands
are limited to these original packages and named tests in an isolated checkout:

```text
# Original H-CODEX-001 transport gates only, from backend through terminal Foreman CI:
go build ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go vet ./internal/harnesses/codex ./internal/harnesses/codex/protocol
staticcheck ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go test -count=1 ./internal/harnesses/codex ./internal/harnesses/codex/protocol
go test -race -count=1 -run '^TestTransport(CorrelatesOutOfOrderResponses|CancellationDuringValidationSendsNothing|QueuedRequestCancellationSendsNothing|CanceledResponseBeforeWriteIsDefinite|ResponseCancellationAfterWriteIsUncertain|CancellationReconcilesLateResponseWithoutReplay|InvalidResponseRetainsLateReconciliation)$' ./internal/harnesses/codex
go test -tags=integration -count=1 -run '^TestScriptedAppServerSessionAndTurn$' ./internal/harnesses/codex
```

The original transport formatting selection is its explicit changed Go-file
manifest, including the generated native types. The original Node integration
test copies the pinned repository fake app-server
to an owned temporary directory and uses isolated HOME, CODEX_HOME, state, and
temporary paths. It needs Node from the CI environment. No DB, port, worker
pairing, installed provider, or credentials are required for that transport
increment.

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
