# Claude bounded queues

This package ports the queue behavior used by the frozen Claude runner and turn
observers. It is a Step 2 building block for the Go session manager; it does not
register a harness, publish sessions, execute a turn, or grant tool access.

The behavior source is `apps/api/src/modules/harnesses/claudeSdk/queue.ts` in
`nima20002000/foreman-code-go` at frozen commit
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`, blob
`360b497fdb43042bf6b0556d44b984898a3646c0`. Its consumers are `runner.ts` (prompt
and raw SDK output queues) and `sessionState.ts` (turn observer queues). No newer
TypeScript fixes were consulted.

## Queue behavior

- `New` requires a positive retained capacity. `Offer` waits when that buffer is
  full, preserving producer order.
- A waiting reader receives a value directly. An optional coalescer can replace
  only the full buffer's last value, while no writer is waiting; it cannot pass a
  control or terminal event already queued by another producer.
- Offer cancellation preserves its context cause and withdraws an unaccepted
  value before a later admission, discard, or closure can settle that producer.
  Cancellation after queue acceptance does not relabel it as withdrawn.
- `Close(failure, false)` rejects waiting writers while preserving buffered
  events. Readers drain those events before receiving the terminal outcome.
- `Discard`, and `Close(failure, true)`, release live waiting writers successfully
  and discard their values. Writers canceled before that action keep their cause.
  This mirrors observer detachment in the frozen behavior.
  **Offer success is only a queue outcome, never a native delivery receipt.**
- `Reader.Detach` ends only that reader. A subsequent reader can continue, and a
  detached reader cannot release another reader's pending call.

The generic value type avoids introducing any Foreman domain DTO. Future session
code must use I's generated contracts for events and sessions, retain the frozen
text-coalescing rules, and continue to derive native receipts only from actual
native observations. The runner's capacities and session authorization are not
chosen by this package.

## Verification status and affected request

The terminal controller reported these completed queue results:

- Original cancellation witness source
  `94dd12d581d9626f4b5d41af316c293936596f4f`, tree
  `5e01036f253ca71d2d74d8286f07315b78f21301`, ticket
  `295daf72-c293-4470-8107-93aa903be52a`: three roots and four subtests,
  seven assertion failures.
- Corrected source `7c23c4516a54634c2b3a50a05bfe11f095eb6aee`, ticket
  `e21470a7-c79e-4648-9c60-be6e13c8cdf6`: sixteen roots and four subtests,
  twenty passes in one race run; build and vet exited zero; both existing
  Go files were formatting-clean, and cleanup succeeded. Staticcheck retained
  two ST1005 findings on the closed and reader-exists sentinel declarations.

Those are retained controller results, not execution performed during this
authoring turn. The original twenty-case file stays unchanged. The current
repair preserves the two public sentinel messages, error-interface types,
identity, and wrapping behavior through explicit error representations. Its
new compatibility guard is expected to pass before and after that repair;
it is not a behavioral red witness. The Staticcheck repair remains unqualified
until the terminal records a clean result on the corrected candidate.

Source review also confirmed a distinct public capacity-diagnostic regression:
`New` returned `invalid Claude queue capacity`, while the frozen constructor
reports `Invalid Claude queue capacity`. The corrected sentinel restores that
exact message. The test-only capacity witness identified in the cumulative
manifest is based on `44a4a7e15249a295650027fd7682490aef73155d`, retains original
queue blob `0e05f9e11d8f079fa8691c675690f475ad1e81bd`, and adds only the new public
diagnostic tests. Its capacity assertion is a proposed pre-fix failure, not a
claimed runtime result. The prior Claude bridge sources remain unchanged.

Only terminal-dispatched Foreman CI MCP may execute the affected checks. From
`backend`, the sole affected package is `./internal/harnesses/claude/queue`.
Use the existing pinned Go 1.27.2 and Staticcheck v0.8.2. On the test-only witness,
select only the new capacity case:

```text
go test -json -count=1 -timeout=30s -run '^TestCapacityErrorPreservesFrozenMessage$' ./internal/harnesses/claude/queue
```

On the corrected candidate, select the capacity case and the new compatibility
guard only, followed by package-scoped Staticcheck:

```text
go test -race -json -count=1 -timeout=30s -run '^(TestCapacityErrorPreservesFrozenMessage|TestQueuePublicErrorCompatibility)$' ./internal/harnesses/claude/queue
staticcheck ./internal/harnesses/claude/queue
```

The corrected selection has two roots and two subtests. Do not repeat the prior
twenty outcomes, package build/vet, or unrelated H checks for this repair.
Formatting is limited to the two changed Go files. From `backend`, use the
verified compiler's own formatter and propagate failure before checking output:

```text
H_QUEUE_GO_VERSION="$(env -u GOROOT GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS= go env GOVERSION)" &&
test "$H_QUEUE_GO_VERSION" = go1.27.2 &&
H_QUEUE_GO_ROOT="$(env -u GOROOT GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS= go env GOROOT)" &&
H_QUEUE_FORMATTED_PATHS="$("$H_QUEUE_GO_ROOT/bin/gofmt" -l internal/harnesses/claude/queue/queue.go internal/harnesses/claude/queue/diagnostics_test.go)" &&
test -z "$H_QUEUE_FORMATTED_PATHS"
```

All new capacity, compatibility, Staticcheck, and formatting gates remain pending
terminal CI. No local test, build, race, lint, formatter, syntax check, or
generator was run during this repair.

Concurrency tests use Go 1.25's standard
[`testing/synctest` API](https://pkg.go.dev/testing/synctest@go1.25.0) to wait for
blocked goroutines without scheduler sleeps or access to private queue state.
The pinned module already requires Go 1.25.0. No database, network, files,
provider installation, credentials, or worker pairing is used by these tests.

No existing conformance scenario directly exercises this queue. Q-CONF owns the
missing native queue/backpressure/observer scenario. The existing
`harness.claude-setup-options` and `harness.claude-unconfigured` IDs are
configuration references, not queue coverage.
