# SCH-10 — selected-Run chat and Activities

Base: `eaeb5406c687787cc000094869abeaa4f9cd26dc`
Branch: `feat/nim-2701-schedules`

## Mount lines for SCH-BOARD

No changes are supplied for `apps/web/src/app/router.tsx`,
`apps/web/src/routes/WorkspaceRouteEntry.tsx`, or
`apps/web/src/features/workflow-board/WorkflowBoard.tsx`.
The route steps in `features/runs-selector/README.md` remain required, unchanged.

Use the **same** `selectedRun` value already passed to `RunsSelector` and
`RunBoard`/`RunBoardSlot`. In WorkflowBoard, import:

```tsx
import { AgentChatPanel } from '../graph/AgentPanels'
```

Mount this in the historical side of the Board layout, outside the editable
canvas's hidden/retained subtree:

```tsx
{selectedRun.active && (selectedRun.invalid || selectedRun.identity.runId !== null)
  ? <AgentChatPanel name="Agent chat" selectedRun={selectedRun} />
  : null}
```

This is a complete historical panel: saved-Agent picker, explicit execution
picker when required, existing chat transcript/composer/controls, and
execution-scoped Activities. It works with the base RunBoardCanvas, whose
snapshot nodes are inert; no canvas changes are required to select a removed
Agent. Keep the Current workflow's existing chat mounts and context unchanged.
Do not merely hide an active Current workflow chat beneath history; its
transcript should be unmounted or otherwise excluded from the visible history
branch. Drafts remain in the existing protected draft store, not the canvas.

For a future snapshot-node chat button, pass the saved node ID, not an Agent
lookup from the current graph:

```tsx
<AgentChatPanel
  name={snapshotNode.name}
  selectedRun={selectedRun}
  selectedRunNodeId={snapshotNode.id}
/>
```

A supplied node that is absent from the snapshot does not fall back to another
Agent. An existing `context.workflowNodeId` is also honored when its workspace
and workflow match the selection; the actual Agent and name still come from the
snapshot. With no requested node, the first saved node is initially displayed,
and all saved nodes are selectable. The `Execution` button reopens the execution
choice. Choosing an execution never changes the selected Run URL.

### Existing standalone Activities drawer

The historical chat panel already includes Activities. Do not mount a duplicate
copy beside it. Where the Board renders a separate **Run-wide** Activities tab,
use this for the historical branch instead of the current/pinned Run's details
container:

```tsx
import { Activities } from './Activities'

<Activities selection={selectedRun} />
```

Keep the existing `<Activities scope={currentScope} />` in Current workflow.
In particular, do not mount `CurrentRunDetails` with a historical scope just to
obtain Activities: that container also owns current-Run action/Stop readbacks.
`Activities` now owns its scope-remount boundary. Callers need not invent keys,
workflow-version pins, or semantics values. Its filter navigation preserves
`selectedRunId`, unrelated search fields, and the hash.

## Identity and request ownership

The historical lookup uses SCH-06:

```
GET /api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId[?executionId=...]
POST <that node path>/messages
POST <that node path>/interrupt
```

Only the shared schemas and authenticated `apiClient` are used. Historical
send strips the legacy `context` body and sends the selected `executionId` plus
message/preconditions. Historical interrupt sends execution, Agent,
conversation, request, and optional native-turn precondition. History, SSE,
queued cancellation, and native approval replies reuse the existing
conversation routes, as required by SCH-06. No GraphQL workflow MCP, Operator
credentials, worker credentials, or management Run writes were added.

A lookup query retains only identity/context. It does **not** retain another
transcript or capabilities projection. The existing `useAgentChat` query owns
state, history, receipts and native activities. Its historical query keys carry
workspace/workflow/Run/node/execution/Agent/conversation plus the URL visit and
panel visit. Draft and command keys carry the complete durable identity without
the visit, so returning to a conversation recovers its draft and unresolved
commands. The null-conversation address is provisional, never a fabricated
`SelectedRunChatKey`.

First-send identity promotion settles any unchanged submitted draft before
moving remaining text to the server-confirmed conversation address. An existing
destination draft wins; the provisional text is not overwritten. Original
creation mutations remain in the Query mutation cache and are matched only to
their exact execution/conversation. No mutation/receipt is cloned into a second
outbox. A late acknowledgement from a departed visit cannot update the active
snapshot or draft. When its owner is revisited, it can trigger a fresh authorized
read and reconcile only that owner's unchanged draft.

URL generation guards handle A -> B -> A even before React cleanup. Mount leases
also guard node/execution changes and effect disposal. Guards cover read results,
history paging, SSE snapshots/deltas/reconnects, write admission/acknowledgements,
Activities reads, and older-page scroll/cache callbacks. Transcript/history
queries for a departed historical visit are not retained. Existing acknowledgement
retirement and unknown-result/no-automatic-resend rules are retained.

Saved-Agent/execution picker interaction is transient Zustand state scoped to a
panel and Run visit; it is not another Run selection source. Drafts remain in the
existing protected Zustand/storage boundary. Refresh/back/forward Run selection
continues to belong exclusively to the existing Runs selector URL hook.

## Activities and unavailable sessions

Public Run Activities have execution references but **no conversation ID** in
the frozen wire contract. The panel partitions their UI/query cache by the
complete chat binding and shows only explicit matching execution references
(and matching node endpoints when present). Run-level or other-execution facts
remain available in the standalone Run-wide Activities view. Chat-native
activities remain in the existing transcript and are never synthesized as Run
results. No timer invents progress or changes saved outcomes.

The snapshot supplies the Activities workflow-version pin; the existing public
Activities response schema independently enforces semantics version 3. Legacy
full-scope callers still receive the original strict scope validation. A legacy
snapshot without a version is shown as unavailable rather than substituting
current-workflow data.

Missing/unavailable sessions retain authorized stored transcript text, show a
short status with the server reason in its tooltip, and render no composer.
No replacement-session or outside-Run chat action is offered in this historical
panel. The current workflow's existing behavior remains on the legacy path.

For more than 100 execution hints, the frozen response provides only
`hasMoreExecutions`, not a paging cursor. The picker therefore offers an explicit
Execution ID field rather than choosing a hidden/latest execution. Server
validation/authorization remains authoritative for that ID. This is a contract
limitation, not an inferred paging protocol.

## Validation and limits of this handoff

Added Vitest/MSW suites cover the shared-Agent/two-Run case, removed Agents,
queued and active turns, sending across Run switches, returning before an old
send settles, late stream snapshots, A -> B -> A reads, unavailable/ephemeral
sessions, explicit execution choice, first-send draft promotion, new Run arrival,
Current workflow draft restoration, Activities paging/filter navigation, legacy
and denied snapshots, and historical HTTP route/precondition validation.

**These Vitest/MSW tests have not been run in this environment.** The full pinned
checkout/dependencies could not be restored: container Git access failed DNS,
and `corepack pnpm install --frozen-lockfile` failed bootstrapping pinned
`pnpm@11.27.0` with `getaddrinfo EAI_AGAIN registry.npmjs.org`. The edited
originals were fetched through the GitHub connector at the exact base SHA and
verified against their Git blob hashes. No lockfile/package changes, alternate
package manager, release-age bypass, or provider-version substitution is in
this ZIP.

Supplementary verification actually run:

- `SCH10.offline.smoke.mjs`: **17 passed**, zero failures. This includes syntax
  transpilation of the 12 delivered TS/TSX files and pure identity/lease checks.
- Compiler used for that supplement: global TypeScript **5.8.3**, Node **22.16.0**.
  It is not the repository's pinned compiler and is not a semantic typecheck.
- Changed-original blob hashes, forbidden-file exclusion, ZIP paths, and SHA-256
  inventory checked during packaging.

Not run: repository typecheck, ESLint, web build, Vitest/MSW (new and existing),
DB/integration/acceptance gates, browser/390px visual checks, real Codex/OpenCode,
or MCP parity qualification. This is source-complete for the supplied component
seams, but it is **not a gate-verified or mounted end-to-end implementation**.
The reserved Board/route owner must apply the mount lines above and qualify the
combined application.

After restoring the pinned workspace normally, start with:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/web test -- src/features/conversations/agentChat/SCH10.selectedRunChat.test.tsx src/features/conversations/agentChat/SCH10.selectedRunChatClient.test.ts src/features/conversations/agentChat/SCH10.selectedRunChatModel.test.ts
corepack pnpm --filter @graphql/web test -- src/features/conversations/agentChat src/features/runs-selector src/features/run-board
corepack pnpm --filter @graphql/web typecheck
corepack pnpm --filter @graphql/web lint
corepack pnpm --filter @graphql/web build
```

Also run the repository's required integration/acceptance gates after the mount
is merged with SCH-BOARD. The optional offline supplement can be rerun with
`node --test src/features/conversations/agentChat/SCH10.offline.smoke.mjs` from
`apps/web`; it intentionally prints the actual compiler version it loads.
