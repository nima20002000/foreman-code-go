# Command receipt persistence

This package is the first bounded catalog increment. It ports the receipt lookup
and completion-retention portions of the frozen TypeScript command coordinator.
It does not yet provide the management command coordinator or workspace and
workflow routes.

`LookupReceipt` accepts already-resolved receipt principal IDs, operation,
command ID, target key, and the hash already computed by the shared command
identity implementation. The future coordinator must perform live authorization
under its command lock before calling it, including retries. The function returns
the issuing principal and original persisted JSON response, rejects a conflicting
input hash or target, and reports `COMMAND_RESULT_EXPIRED` when the successful
audit remains after the response is removed. It never executes a command.

`PruneCompletedCommandReceipts` implements the existing thirty-day policy and
one-hundred-candidate batch. Its store port contains internal persistence
projections, not public domain contracts. `PostgresReceiptRetention` reads the
latest successful completion audit, advances past unfinished or unaudited rows,
wraps after exhausting the cursor, and deletes only the selected activity
revision. The success audit always remains. Pending or uncertain chat controls,
unacknowledged accepted controls, permanent bindings, workflow version facts,
repository recovery records, and unknown operation kinds remain retained.

The Go cursor uses native `time.Time` and `int64` values so PostgreSQL timestamp
and revision precision survives round trips without copying the TypeScript
driver's string encodings. The mutation query still uses the existing database
revision comparison. Cleanup scheduling belongs to the composition owner.

## Remaining shared foundations

The pinned skeleton explicitly defers generated domain types and validators,
canonical JSON, and shared live-principal/access services. This increment does
not fill those gaps with local definitions. Management command inputs, principal
resolution, authorization, canonical hashing, lock and transaction orchestration,
native-effect preparation/compensation, success/failure audit writes, command
resume/replay adapters, and HTTP/MCP registration remain to be ported using those
shared foundations. Saved workflows continue to require execution semantics 3.

## Authored verification

The ordinary tests exercise retention through its store port. Integration-tagged
tests restore the actual embedded TypeScript baseline into a unique disposable
PostgreSQL database, read results through exported package functions, and inspect
persisted receipts and audits through an independent connection. They cover
retry identity, conflicting input and targets, expiration fences, cancellation,
retention boundaries, bounded cursor progress, and an actual concurrent result
update between selection and removal. Each test isolates HOME and XDG state.

Tests, compilation, vet, formatting, and lint have not been executed in the Web
authoring environment. Only the terminal may dispatch the affected
`backend/internal/commands` checks through Foreman CI MCP. Existing public
workspace/workflow conformance scenarios remain blocked by their missing route
and shared-contract implementations. Q-CONF must supply a directly targeted
receipt-retention scenario; none is claimed here.
