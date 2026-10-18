# Activity and history cursor primitives

This package contains stored-source cursor checks for conversation messages,
turns and activity, plus the public run-history cursor codec. HTTP routes,
Operator MCP tools and browser streams are composed in later read services.

## Conversation read-page anchors

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

## Run-history cursor behavior

The source is apps/api/src/modules/runs/historyCursor.ts at the same frozen
reference. The codec preserves all six PostgreSQL timestamp fractional digits,
the Run ID tie-breaker and the exact workspace/workflow filter hash. A missing
workflow filter and an empty workflow string have different identities.

A nil cursor is the first page. Present cursors require the frozen four-element
array, version 1, the matching scope, a real calendar timestamp, and a nonempty
Run ID unchanged by ECMAScript trim and containing no NUL. Base64url, JSON bytes
and the 16,384-character cursor limit are checked by exact re-encoding.
Failures retain RUN_HISTORY_CURSOR_INVALID, status 400 and the frozen message.
A cursor is only a page boundary; every reader must authorize its complete scope.

### Shared lossless string boundary

EncodeRunHistoryCursor and DecodeRunHistoryCursor accept either ordinary Go
strings or jsonvalue.UTF16String for scope identifiers. Workspace and optional
workflow use the same representation in each call; a nil workflow pointer means
the absent filter. Encode accepts either representation for the Run ID,
independently of the scope representation.

Decode returns the Run ID as I's jsonvalue.UTF16String. Lone high/low surrogates,
valid pairs, U+FFFD and literal backslash escapes remain different values.
The timestamp remains Go string text because its accepted format is ASCII.
There is no private string carrier, copied domain DTO or local JSON serializer.
Ordinary Go strings enter through I's valid-UTF-8 boundary; arbitrary invalid
Go byte strings are not silently normalized into identifiers.

jsonvalue.Parse retains parsed string units. NumberFloat64 supplies the frozen
numeric comparison before the final canonical check. canonicaljson.Canonical
encodes both fixed arrays; their elements have no objects, so its string/number
rules produce the same bytes as the frozen JSON.stringify calls. Run ID trim
and NUL checks inspect code units without converting to UTF-8.

Keep a decoded Run ID in its shared representation. UTF16String.IdentityKey
is suitable only for exact map/identity comparisons. It is not the Run ID's
UTF-8 text or its database/JSON wire value. UTF16String.UTF8 explicitly fails
for lone surrogates; callers must not discard that error or substitute U+FFFD,
a literal escape, or the opaque identity key.

### Cursor regression evidence and affected checks

The controller supplied genuine pre-fix red ticket
71db2bb9-727d-4a9a-b66e-c9e36e49e94c on the original implementation plus the
unchanged two-test witness: both high/low cases assertion-failed at decoding,
and cleanup passed. No repeat of that red run is requested.

The witness history_cursor_surrogate_test.go is byte-identical to published
f1cc0f39629c7dc3f2b87dd04857e17d4f5c8bd2
(blob 3d694a7f2ff54c2855214d7a8214c27ce08f58d4). All seven original history
test functions and all three proposal functions are retained. Ordinary-text
readback assertions now perform explicit UTF8 conversion, and the proposal's
identity comparisons use IdentityKey/Equal. All original cases and the
proposal's 23 subtests retain their acceptance, rejection and exact-wire
expectations. These 12 functions and 71 subtests are authored; this replacement
has not been executed in Web or local tools.

After immutable review, request only the affected cursor tests through
terminal-dispatched Foreman CI MCP, from backend/:

    go test ./internal/activity -run '^(TestRunHistoryCursor(PreservesMicroseconds|MatchesFrozenArrayEncoding|BindsTheExactWorkflowFilter|RejectsNoncanonicalAndMalformedPositions|RejectsInvalidCalendarPositions|RetainsTheFrozenRunIDRules|RetainsEscapedHighSurrogate|RetainsEscapedLowSurrogate|KeepsDistinctStringIdentities|PreservesSurrogateScopeIdentity|RejectsNoncanonicalSurrogateEscapes)|TestRunHistoryFirstPageIsDistinctFromAnEmptyCursor)$' -count=1
    go build ./internal/activity
    go vet ./internal/activity
    staticcheck ./internal/activity

Formatting is limited to history_cursor.go, history_cursor_test.go,
history_cursor_surrogate_test.go and history_cursor_string_identity_test.go.
All execution, including formatting verification, belongs to terminal CI.
The repair directly consumes unchanged canonicaljson, jsonvalue and domainerror.
It changes no anchor, transaction, engine, interaction or shared-foundation code.
The already-qualified foundation/producer, five-package and race checks are
not requested again. This cursor selection opens no DB, server or worker.

## Remaining read-service boundaries

The repair base is e8a6fb3a66f5a592e1f07a10838b456caadcfee2. It supplies the shared
lossless values and encoder; generated domain schemas/types remain an I-owned
foundation. Do not fill that boundary with handwritten contract structs.

The frozen RunHistoryService.list in apps/api/src/modules/runs/history.ts uses
RunDropdownListInput, RunDropdownPage and RunDropdownSummary from shared
run-snapshots contracts, plus ManagementPrincipal and live access checks.
Those generated values must retain their identifier identity. Its SQL query
passes workspace/workflow IDs and cursor.runId into PostgreSQL text parameters
and compares the Run ID with C collation. The I-owned database text boundary
must specify the matching native UTF-8 parameter behavior before that service
is wired. The working codec does not choose a lossy conversion for those
future consumers. Its public lossless-string acceptance is separate from the
remaining service and persistence integration.

Full activity/history projections also require generated ActivitySnapshotV1,
ActivityScope, ActivityItem, ActivitySourceRevision, WorkRef, WorkSummary,
InteractionSummary, ReadObservation and the run-snapshot schemas/types.
Step 2 additionally requires generated run-live-activity and subagent contracts.
Preserve live principal rechecks, saved WorkflowVersion facts, scope filtering
and expiry checks throughout later read services. Composition belongs to I;
E's atomic resume operation and execution semantics 3 are unchanged.

## Retained anchor checks

Three unit-test functions and two integration-test functions cover the existing
anchor behavior. The integration tests use internal/testdb and independent
reader/writer pools for persisted ownership, bigint anchors and repeatable-read
consistency during committed updates and deletions. They are not reselected
for this cursor-only repair.

For future affected anchor work, the scoped terminal CI instructions remain:

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

Anchor dependencies remain internal/database and internal/domainerror;
integration tests additionally use internal/testdb and internal/config.

## Conformance coverage

No conformance gain is claimed for these unwired primitives. Related existing
lane scenario IDs are conversation.create-replay-history,
mcp.conversations.create-read, streams.operator.native-order,
streams.operator.snapshot-framing, streams.operator.reconnect-snapshot and
streams.operator.invalid-caller. They exercise later composed services and
are not requested to qualify this cursor repair. Q-CONF owns the missing
direct run-history cursor/string-identity coverage and the source-anchor
ownership/expiry/paging scenarios. No conformance expectations are changed.
