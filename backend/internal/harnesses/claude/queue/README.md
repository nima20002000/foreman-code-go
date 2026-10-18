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

All tests are authored and unrun. No test, build, race, lint, formatter, syntax
check, or generator was executed during authoring. This is a new isolated port;
an absent package on the base is not a pre-fix behavioral red result. Peer review
identified a cancellation-order defect in the initial implementation. The three
public regressions are retained with that unchanged implementation at tests-only
pre-fix commit `94dd12d581d9626f4b5d41af316c293936596f4f`, tree
`5e01036f253ca71d2d74d8286f07315b78f21301`. Terminal CI must establish the actual
red result there and the fixed result on the reviewed successor before merge.
The prior Claude bridge red witness and corrected candidate remain unchanged.

Only terminal-dispatched Foreman CI MCP may execute the affected checks. From
`backend`, the sole affected package is `./internal/harnesses/claude/queue`.
Run its 16 named public-interface tests with `go test -count=1`, and the nine
concurrent offer/reader tests selected in the handoff's CI request with `-race`.
Build, vet and staticcheck should name that package explicitly. Formatting is
limited to `queue.go` and `queue_test.go`.

Concurrency tests use Go 1.25's standard
[`testing/synctest` API](https://pkg.go.dev/testing/synctest@go1.25.0) to wait for
blocked goroutines without scheduler sleeps or access to private queue state.
The pinned module already requires Go 1.25.0. No database, network, files,
provider installation, credentials, or worker pairing is used by these tests.

No existing conformance scenario directly exercises this queue. Q-CONF owns the
missing native queue/backpressure/observer scenario. The existing
`harness.claude-setup-options` and `harness.claude-unconfigured` IDs are
configuration references, not queue coverage.
