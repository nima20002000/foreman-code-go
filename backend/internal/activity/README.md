# Activity and history read side

This first increment ports the cursor behavior that is independent of generated
domain contracts. It does not register an HTTP route, MCP tool or browser stream.

## Ported behavior

- Run-history cursors preserve PostgreSQL's six fractional timestamp digits and
  the Run ID. Their canonical unpadded base64url payload binds to the exact
  workspace and optional workflow filter. An absent workflow filter is distinct
  from an empty filter. Invalid values retain `RUN_HISTORY_CURSOR_INVALID`, HTTP
  status 400 and the frozen public message.
- Conversation message, turn and activity cursors must identify a real stored
  source row. A missing source returns the corresponding `*_CURSOR_EXPIRED` /
  410 failure; another conversation's source returns
  `*_CURSOR_SCOPE_CONFLICT` / 409. Driver failures remain driver failures.
- Conversation checks must run inside the page service's existing shared
  `database.WithTransaction` operation with repeatable-read isolation. The
  helpers neither begin transactions nor grant authorization.

The cursor JSON bytes follow the source's `JSON.stringify` array format,
including its Unicode and whitespace rules. This is not a new canonical JSON
service. No shared domain DTO is defined here.

Frozen behavioral sources are in the fork at
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`:

- `apps/api/src/modules/runs/historyCursor.ts`
- `apps/api/src/modules/runs/history.ts`
- `apps/api/src/modules/conversations/activityCursor.ts`

## Integration boundaries

The exact base, `7fa547058109519a99c904493c916662fde6a474`, has no generated
contracts package, JSON Schema export or concrete shared access implementation.
Its backend README explicitly forbids filling this gap with handwritten domain
structs. Those I-owned foundations are required before full projection services
and public routes can be added. The composition root also belongs to I.

The next activity/history slice needs generated `ActivitySnapshotV1`,
`ActivityScope`, `ActivityItem`, `ActivitySourceRevision`, `WorkRef`, `WorkSummary`,
`InteractionSummary`, `ReadObservation`, and the run-snapshot schemas and types
(`RunDropdownListInput`, `RunDropdownPage`, `RunDropdownSummary`,
`RunBoardSnapshotGetInput`, `RunBoardSnapshotGetResult`, `RunBoardSnapshot`).
Step 2 also needs the generated run-live-activity and subagent contracts.

Run-history reads must preserve live principal rechecks, Run-only scope filters,
saved WorkflowVersion facts, authorization during the read transaction and
expiry checks after asynchronous reads. A cursor cannot authorize a read.
Native-delivery receipts and persisted pending interactions do not prove
provider qualification, response availability or a worker ACK.

Inspection cursors are deferred: their scope includes generated Run-scope
objects, and the frozen object-property order participates in the scope hash.
Do not invent a substitute object shape or a new serializer at this layer.

## Verification status and affected request

Ten unit-test functions and two integration-test functions are authored.
Nothing has been built, tested, formatted or linted in this environment.
The integration tests use only `internal/testdb`'s fresh disposable PostgreSQL
database. They verify persisted source ownership, bigint anchors and the
repeatable-read page snapshot while an independent writer commits updates and
deletions.

The terminal must dispatch only the affected package through Foreman CI MCP:

    go test ./internal/activity -run '^Test(RunHistory|Conversation)' -count=1
    go test -tags=integration ./internal/activity -run '^TestPostgresConversationCursor' -count=1
    go build ./internal/activity
    go vet ./internal/activity
    staticcheck ./internal/activity

Run these from `backend/`. Formatting applies only to this package's changed Go
files. Imports use the unchanged shared `database` and `domainerror` foundations;
integration tests additionally use unchanged `testdb` and `config`. No package
outside this increment imports `activity` on the pinned candidate.

No current conformance gain is claimed. Related existing scenario IDs include
`conversation.create-replay-history`, `mcp.conversations.create-read`,
`streams.operator.native-order`, `streams.operator.snapshot-framing`,
`streams.operator.reconnect-snapshot` and `streams.operator.invalid-caller`.
They exercise later composed services and must not be used to qualify this
unwired utility. Q-CONF must provide direct cursor-scope and paging scenarios.
No conformance expectations are changed here.

There is no pre-fix CI red evidence. A tests-only overlay on the base would
fail to compile because this package does not yet exist; that is not a
behavioral regression result. The terminal must obtain the required actual
behavioral evidence before merging a fix and record its exact ticket and SHA.
