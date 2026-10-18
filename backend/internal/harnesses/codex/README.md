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

The generator checks the captured input digests and uses the pinned toolchain's
formatter before writing source. The input checks are provenance for reproducible source generation. They are not runtime
qualification, schema validation, or a substitute for the actual installation's
emitted schema. Production admission must supply that validation through
`Protocol`; the injected validator in the tests is only a fixture.

## Current producer/formatter repair — terminal Foreman CI only

The cumulative source checkpoint is
`4c62661a55b7db3f2fcd9e3a3145bdfa834de102`, tree
`9987cdfe2533de8b8ec5a16904d73f4de4d0e50f`. It retains the actual CI formatter
postimages. Its uncorrected producer still emits 24,702 unformatted bytes with
SHA-256 `65cb5d2cf043ad919e2a3e1036090c4491dbd43d2f39ba257e5e5037f629b315`.
The retained `protocol/types.gen.go` is 30,940 bytes, Git blob
`7fc2a587cb26656be14ef062d5739983197d2d43`, SHA-256
`8a966f0c0a54c6e21e3b0513719032f95217564e3c984fd081c1bec4433eafda`.
The current repair preserves that entire generated file.

The corrected producer requires the repository-pinned Go 1.27.2 on `PATH`.
It queries that compiler with automatic toolchain selection and user Go
configuration disabled, checks the exact version, and runs the `gofmt` in
the compiler's own `GOROOT/bin`. It writes the full formatter output only
after successful formatting. Missing or failed tools and a wrong compiler
version leave existing output untouched. There is no formatter approximation
or fallback to another formatter.

Use fresh isolated CI checkouts of the test-only witness and corrected
candidate recorded in the repair manifest. CI supplies its genuine pinned
toolchain, private HOME/config/state/temporary paths, and the exact frozen
input bytes. These affected commands need no database, port, worker pairing,
provider installation, or credentials. All commands below run from the
repository root through terminal Foreman CI; no execution is claimed here.

### Pre-fix formatting witness

The test-only witness preserves the checkpoint producer and formatted output.
Select only this new public CLI case on that witness:

```text
python3 backend/internal/harnesses/codex/protocol/generate_types_test.py -v GeneratorCLITests.test_generated_output_is_already_gofmt_formatted
```

The test invokes the existing CLI options, requires successful generation,
verifies actual Go 1.27.2, and requires genuine formatter success before
comparing all generated bytes with the formatter's output. Only the final
byte comparison is the expected pre-fix assertion failure. An unavailable
tool, wrong Go version, failed producer, or rejected option is not that witness.

Also invoke that same original producer directly and compare its complete
output with the retained formatted checkpoint file. Set `H_GENERATOR_OUTPUT`
to an owned temporary file outside the checkout:

```text
python3 backend/internal/harnesses/codex/protocol/generate_types.py --schema apps/api/test/fixtures/codex-protocol.schemas.json --method-source scripts/generate-codex-method-types.mjs --output "$H_GENERATOR_OUTPUT"
cmp -- "$H_GENERATOR_OUTPUT" backend/internal/harnesses/codex/protocol/types.gen.go
```

Generation must succeed; the subsequent `cmp` mismatch is the expected
reproduction blocker. Retain both complete output artifacts and their actual
SHA-256 values. The generated-output digest above is the prior controller's
reported identity, not a replacement for this invocation's result.

### Corrected-candidate gates

Run these four affected public CLI cases on the corrected candidate:

```text
python3 backend/internal/harnesses/codex/protocol/generate_types_test.py -v GeneratorCLITests.test_frozen_native_inputs_generate_reproducibly GeneratorCLITests.test_added_newline_is_rejected_without_touching_output GeneratorCLITests.test_generated_output_is_already_gofmt_formatted GeneratorCLITests.test_missing_go_toolchain_preserves_existing_output
```

The first two retained cases are affected because valid generation now calls
the formatter. The formatting case verifies the corrected public output.
The missing-Go case is a new dependency/error-preservation guard; it is not
evidence of the old formatting mismatch and is not selected for the pre-fix run.

Repeat the direct generator invocation and full `cmp` above with a fresh owned
output on the corrected candidate; both must succeed. Then use the same pinned
formatter for the retained generated file's exact formatting scope:

```text
H_PINNED_GO_VERSION="$(env -u GOROOT GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS= go env GOVERSION)" &&
test "$H_PINNED_GO_VERSION" = go1.27.2 &&
H_PINNED_GO_ROOT="$(env -u GOROOT GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS= go env GOROOT)" &&
H_PINNED_GOFMT="$H_PINNED_GO_ROOT/bin/gofmt" &&
H_FORMATTED_PATHS="$("$H_PINNED_GOFMT" -l backend/internal/harnesses/codex/protocol/types.gen.go)" &&
test -z "$H_FORMATTED_PATHS"
```

The command chain propagates toolchain and formatter failures before checking
for nonempty formatting output. The entire chain must exit successfully.

Preserve the raw CLI outcomes, exact source/test identities, formatter version,
full reproduction artifacts and digests, and comparison/formatting results.
The witness and these corrected gates remain pending until the terminal
controller records actual outcomes. This repair requests no Codex transport
behavior, package build/vet/lint, integration, or full-suite repetition.

## Retained historical evidence — no repeat dispatch in this repair

The earlier input-provenance repair used tests-only source
`557d759decb4cdf6accdcac4c800a22cf6c95e12`; corrected source is
`81bbcb80aaa4324d834b45b684d361e49cf62188`. The controller reported two assertion
failures under ticket prefix `f5b7aac6`, then two passes under `0f0c0dbb` plus
a successful full-output comparison. Those results preceded the formatter
postimages and do not qualify the current producer/checked-in-output mismatch.

Original transport source
`c62fb50521c798969e7cb434b856841641297bee` and cancellation witness
`0ace55b2dc96fe898b82ce87c8fb2ba49b4d90d2` remain retained source identities.
The controller's authentic old cancellation run, ticket prefix `d3cb4cfa`,
had three passes and one assertion failure. It was not four red outcomes.

The controller subsequently reported ticket
`c60c23f8-c0d6-44c1-a9fd-a7c30440aaa9` with 27 passing outcomes: 26 race outcomes
and the sole fake Node app-server integration case. Build, vet, and Staticcheck
were green; only nine file-format checks failed. All nine actual CI formatter
postimages are preserved in the cumulative checkpoint and remain unchanged by
this repair. These counts are retained controller evidence, not locally
repeated execution. The original `foreman-h-codex-c62fb505-reviewed.zip` remains
the historical transport/witness handoff.

The exact existing Q-CONF scenario for subsequent Codex facade integration is
`harness.codex-configuration-check`. This standalone package does not wire its
route, so that scenario is pending shared contracts, qualification, and
composition. Q-CONF owns the missing native transport correlation, framing,
callback delivery, cancellation, and late reconciliation scenarios; do not
invent IDs or edit expectations in this lane.

## Remaining lane work

Installed-binary protocol acquisition and qualification, domain session mapping,
permission/MCP configuration, provider-account selection, and guardian process
ownership need their existing TypeScript ports and shared generated contracts.
The current runtime skeleton intentionally lacks that shared contract export
and concrete access implementation. This package's explicit low-level ports
allow fake app-server work while those foundations are supplied by their owners.
No execution-semantics fallback or admission receipt is introduced here.
