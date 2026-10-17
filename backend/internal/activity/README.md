# Conversation read-page cursor anchors

This increment contains the stored-source cursor checks for conversation
messages, turns and activity. It does not register HTTP routes, MCP tools,
browser streams or a run-history cursor codec.

## Ported behavior

- A cursor must identify an actual row in its own physical source table.
- A missing anchor returns the corresponding MESSAGE_HISTORY_CURSOR_EXPIRED,
  TURN_HISTORY_CURSOR_EXPIRED or ACTIVITY_CURSOR_EXPIRED failure, with status
  410 and the frozen public message.
- An anchor belonging to another conversation returns the corresponding
  *_CURSOR_SCOPE_CONFLICT failure, with status 409 and the frozen public message.
- An absent cursor is the first page and does not query an anchor.
- Driver failures remain driver failures. A cursor never grants authorization.

Call the checks inside the page service's existing database.WithTransaction
operation with repeatable-read isolation. The helpers do not begin a separate
transaction or define domain DTOs.

The frozen source is
apps/api/src/modules/conversations/activityCursor.ts in the fork at
8d2ea76c5028ef4458bf8cd64ef8624422e71d9f.

## Deferred run-history codec

The earlier authoring candidate f82d367e172afa86eb724fa35f527ea9c2db19c1 included
a run-history codec. Independent review found a parity mismatch for canonical
JSON strings containing an escaped unpaired UTF-16 high or low surrogate.
Frozen TS JSON.parse/JSON.stringify preserves that code unit. Go's standard
encoding/json string decoding replaces it with U+FFFD, and the earlier codec's
canonical re-encoding then rejects the otherwise accepted cursor.

That codec and its tests are excluded from this delivery. The original ZIP and
Git checkpoint are retained unchanged, and all seven earlier history-test
functions are preserved in the handoff's deferred-regression material. Their
expectations were not weakened to qualify the remaining anchor checks.

Before reintroducing the codec, foundation owner I must define the shared
lossless JSON-string/identifier representation used by generated contracts,
serializers and database consumers, including unpaired UTF-16 code units.
A private WTF-8 convention or returning a literal six-character escape as the
Run ID would introduce a different identity contract at this package boundary.

Two additional public-function regression tests for escaped high and low
surrogates accompany the handoff as a separate additive patch against the old
f82d367 candidate. They are deliberately not compiled into this anchor-only
candidate. The terminal's pre-fix request targets the old implementation plus
those tests; package-absence compilation is not behavioral red evidence.
The mismatch and expected red are source-inspection findings; no run occurred.

## Remaining integration boundaries

The exact base is 7fa547058109519a99c904493c916662fde6a474. It has no generated
contracts package/schema export or concrete shared access implementation.
Its backend README explicitly prohibits replacing those I-owned foundations
with handwritten domain structs. Composition registration also belongs to I.

Full activity/history projections require generated ActivitySnapshotV1,
ActivityScope, ActivityItem, ActivitySourceRevision, WorkRef, WorkSummary,
InteractionSummary, ReadObservation and the run-snapshot schemas/types.
Step 2 additionally requires generated run-live-activity and subagent contracts.
Preserve live principal rechecks, saved WorkflowVersion facts, scope filtering
and expiry checks throughout later read services.

## Authored checks and affected terminal request

Three unit-test functions and two integration-test functions are authored for
the retained anchor behavior. No test, build, lint, typecheck or formatting check
has run here. The two integration tests use internal/testdb and independent
reader/writer pools to verify persisted source ownership, bigint anchors and
repeatable-read consistency while updates and deletions commit.

Run only through terminal-dispatched Foreman CI MCP, from backend/:

    go test ./internal/activity -run '^TestConversation' -count=1
    go test -tags=integration ./internal/activity -run '^TestPostgresConversationCursor' -count=1
    go build ./internal/activity
    go vet ./internal/activity
    go vet -tags=integration ./internal/activity
    staticcheck ./internal/activity
    staticcheck -tags=integration ./internal/activity

Integration-tagged execution requires FOREMAN_CODE_CI_TEST_ADMIN_URL from a
fresh disposable CI PostgreSQL provider, with random ports and isolated HOME/
state. There is no fallback to application DATABASE_URL, installations or
paired workers. Missing disposable-provider configuration must fail.

Formatting is scoped to the three changed Go files in this package. Direct
unchanged dependencies are internal/database and internal/domainerror;
integration tests additionally use internal/testdb and internal/config.
No existing package imports activity on this candidate.

No conformance gain is claimed for these unwired utilities. Related existing
scenario IDs are conversation.create-replay-history, mcp.conversations.create-read,
streams.operator.native-order, streams.operator.snapshot-framing,
streams.operator.reconnect-snapshot and streams.operator.invalid-caller.
They exercise later composed services and cannot qualify this utility.
Q-CONF must provide direct source-anchor ownership/expiry and paging scenarios.
No conformance expectations are changed.
