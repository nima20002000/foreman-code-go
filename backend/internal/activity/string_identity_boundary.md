# Run-history cursor string boundary request

Status: interface proposal for foundation owner I, not an implemented or
qualified parity fix. The current diagnostic implementation still has the
reported surrogate mismatch. This document and the added public regression
tests are a retained checkpoint for the same A1 followup.

## Exact source and unchanged red witness

- Original merged fork base: `7fa547058109519a99c904493c916662fde6a474`.
- Frozen TS reference: `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`.
- Existing faulty cursor candidate: `f82d367e172afa86eb724fa35f527ea9c2db19c1`.
- Published diagnostic branch: `go/diagnostic-history-surrogate-f1cc0f3`.
- Diagnostic candidate: `f1cc0f39629c7dc3f2b87dd04857e17d4f5c8bd2`.
- Diagnostic tree: `9e713f148bada051476fa87ad796cdca1bfc0363`.
- Unchanged witness blob: `3d694a7f2ff54c2855214d7a8214c27ce08f58d4`.
- Unchanged implementation blob: `778fbd44cb7bc9178efcb83e85359d8a8e2201db`.

The published diagnostic source was fetched from the fork and matched the
retained Git blobs. No original repository or refreshed TypeScript reference
was used. The earlier anchor-only candidate and ZIP remain retained unchanged.

## Behavior that the shared boundary must preserve

Frozen `apps/api/src/modules/runs/historyCursor.ts` parses a JSON array and
returns the Run ID string. The encoder quotes that same string through
JSON.stringify. An unpaired UTF-16 high or low surrogate remains the same code
unit and has a lowercase JSON escape in a canonical cursor. A valid surrogate
pair is a supplementary Unicode scalar and appears as its UTF-8 bytes in the
canonical cursor. A literal backslash followed by `ud800`, and the replacement
character U+FFFD, are distinct strings.

The cursor also hashes JSON.stringify of the workspace and optional workflow
identifiers. Scope strings and decoded Run IDs therefore need one consistent
representation. Preserving only the original raw cursor token would not repair
the returned identifier or the scope hash. Trimming, rejecting, or substituting
an accepted string would change frozen behavior.

The current Go decoder passes the Run ID token to encoding/json.Unmarshal into
string, which substitutes U+FFFD for a lone surrogate before the canonical
re-encoding check. The two supplied public tests are unchanged. They require
acceptance and exact re-encoding of canonical high/low surrogate payloads.
This is source-inspection evidence only; no red run has occurred in this child.

## Concrete interface proposed to I

Proposed shared package: `backend/internal/jsstring`, owned and supplied by I.
The cursor requires only these two functions:

```go
func DecodeJSON(data []byte) (string, error)
func AppendJSON(dst []byte, value string) ([]byte, error)
```

`DecodeJSON` reads exactly one JSON string token and retains every UTF-16 code
unit, including unpaired high/low surrogates. It returns an error for a nonstring
token or malformed JSON string. `AppendJSON` appends one string token with
JSON.stringify's byte spelling: required JSON escapes, lowercase escaped lone
surrogates, raw supplementary scalars, raw U+2028/U+2029 and no HTML escaping.
The cursor owns its fixed array delimiters, version, timestamp validation,
scope hash and canonical base64 comparison. This request does not require a
generic object serializer or a second canonical JSON implementation in A1.

The proposed carrier is a Go string containing a canonical WTF-8 representation:
ordinary scalar text retains its existing UTF-8 bytes; isolated UTF-16 surrogate
code units have a lossless distinguished representation. I must specify its
validity, equality and all input/output boundaries. This is a proposed shared
decision, not a convention implemented locally by A1. A generated named string
type or different lossless carrier is also an I decision, but it must preserve
the existing public cursor signatures and the unchanged witness call sites.

Existing public signatures that must remain usable are:

```go
func EncodeRunHistoryCursor(workspaceID string, workflowID *string, admittedAt, runID string) (string, error)
func DecodeRunHistoryCursor(workspaceID string, workflowID, cursor *string) (admittedAt, runID string, present bool, err error)
```

I must ensure a shared string survives generated JSON decoding and encoding;
merely generating ordinary strings and leaving their serialization to standard
encoding/json would lose lone surrogates again. A private marker, literal JSON
escape returned as an identifier, or request-local token cache would not retain
the same public identity contract.

## Exact generated types and consumers

All following paths refer to the frozen reference above. This table identifies
existing types and fields; no domain shape is copied into Go.

| Source | Existing boundary requiring the same string identity |
| --- | --- |
| `packages/contracts/src/schemaPrimitives.ts` | `IdSchema` is `z.string().trim().min(1)`; `Id` is intentionally unbranded and is not restricted to UUIDs or ASCII. |
| `packages/contracts/src/runSnapshots.ts` | `RunDropdownListInput.workspaceId` and `.workflowId` use `IdSchema` and feed the scope hash. |
| `packages/contracts/src/runSnapshots.ts` | `RunDropdownSummary.runId` uses `IdSchema`; `RunDropdownPage.items` carries those summaries. |
| `packages/contracts/src/runSnapshots.ts` | `RunBoardSnapshot` and `RunBoardSnapshotGetInput` reuse the workspace/workflow/Run identifiers. These remain later projection work. |
| `apps/api/src/modules/runs/history.ts` | `allowedRunIds` compares `ManagementPrincipal.grants[*].scope.runIds` and intersects live authorization with the supplied principal. |
| `apps/api/src/modules/runs/history.ts` | `RunHistoryService.list` binds decoded `cursor.runId` as SQL parameter 4 and encodes the persisted final row's ID for the next cursor. |

The later pgx binding must explicitly match the frozen Node/pg text boundary;
no implicit conversion may change the cursor's returned value. I should specify
that adapter boundary together with generated serialization. The focused codec
fix does not edit the database schema, C collation, access checks, projection
DTOs, shared transaction helper or engine resume interface.

## Bounded A1 implementation after I supplies the boundary

1. Replace Run ID string unmarshalling with the shared lossless decoder.
2. Replace the local `historyCursorJSON([]any)` helper with fixed scope and
   four-field cursor array assembly using the shared string appender.
3. Use the same appender for workspace, workflow and Run ID. Preserve absent
   workflow as null, separately from an empty filter.
4. Preserve existing timestamp, Run ID trim/NUL, scope, size and canonical
   base64 checks and their public domain error. Do not change the supplied tests.

No actual fix candidate can be qualified until I supplies this shared interface
and its behavior. The published current-main tree
`8edfdba17d4bae2a0c6d8186345054c6efd1fca5` and published `go/i-foundations` at
`b9fa1ed6aba367818a1cccfeafc818d99520c45f` contain no generated contracts or
shared string/JSON package. They were inspected for the prerequisite only; the
TypeScript reference and this diagnostic branch were not refreshed.

## Additive public coverage and terminal request

The unchanged supplied witness functions are:

- `TestRunHistoryCursorRetainsEscapedHighSurrogate`
- `TestRunHistoryCursorRetainsEscapedLowSurrogate`

Three additional authored functions guard distinct identifier values, shared
workspace/workflow scope identity and rejection of noncanonical escape spelling:

- `TestRunHistoryCursorKeepsDistinctStringIdentities`
- `TestRunHistoryCursorPreservesSurrogateScopeIdentity`
- `TestRunHistoryCursorRejectsNoncanonicalSurrogateEscapes`

The additional cases do not encode a particular internal carrier. They obtain
identifiers through the exported decoder, compare distinct values, and feed
those values into the exported encoder's Run/workspace/workflow parameters.
Their fixed wire fixtures are source-derived, not executed TS observations.
All seven prior run-history test functions and their expectations remain intact.

The terminal must run only the original two-case witness first, on diagnostic
`f1cc0f39629c7dc3f2b87dd04857e17d4f5c8bd2`, through Foreman CI MCP from backend/:

```text
go test ./internal/activity -run '^TestRunHistoryCursorRetainsEscaped(High|Low)Surrogate$' -count=1
```

Record its actual ticket and results before requesting the corrected candidate's
affected Run history cases. There is no replacement witness and no package-
absence compilation qualification. After the real fix and I dependency land,
the affected A1 selection is `^TestRunHistory`, followed by build/vet/Staticcheck
for `./internal/activity` and formatting of the actually changed Go files only.
The I package's affected checks belong to I and require exact named selection.
No interaction tests, anchor tests, full suites or wrappers hiding them are
requested by this focused followup. No execution occurred in this child.

No existing conformance ID directly qualifies the cursor primitive. Q-CONF owns
any missing Run-history string/canonical cursor scenario. Related existing IDs
remain `conversation.create-replay-history`, `mcp.conversations.create-read`,
`streams.operator.native-order`, `streams.operator.snapshot-framing`,
`streams.operator.reconnect-snapshot` and `streams.operator.invalid-caller`;
none is claimed as new Run-history coverage. No expectations are edited.
