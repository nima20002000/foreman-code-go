# Connection handoffs and Board Activities

NIM-2691 implements the new work-handoff policy on the existing execution-semantics-3 workflow and Run services. The saved policy marker is `definition.handoffs: { "contractVersion": 1 }`. It is distinct from the old optional `definition.repeat` contract. The two cannot coexist in one saved definition. Omission of both on an **old** saved version retains its ordinary DAG meaning; omission of `maxWorkHandoffsPerRun` on a **marked new** work connection means no per-connection cap.

## Saved work connections

The existing `execution` edge is the canonical work connection. It retains its ID, label, endpoints and graph presentation. Its optional `maxWorkHandoffsPerRun` is an integer from 1 through 2,147,483,647. Missing means unlimited for this connection, with no sentinel in JSON or SQL. `workRequestDirection` is `source_to_target` by default; `both` also permits independently initiated work in the reverse direction. A correlated return is allowed regardless of that setting because it returns the exact admitted request. The backend rejects a second edge for the same unordered node pair in a marked definition, including a reverse edge. The same connection ID and Run-wide counter apply to either permitted new-work direction. Approval relationships remain separate and never carry a work cap.

The marker changes execution meaning, so it is a meaningful staged Save, not a geometry edit. `workflow_validate_v3`, `workflow_save_v3`, `workflow_saved_get_v3` and the matching authenticated HTTP definition endpoints use the same shared `WorkflowDefinitionV3Schema`. The writer publishes a complete immutable definition/version with a new content hash and revision; the current Board draft and Operator MCP send the same fields. No direct edge PATCH is part of this contract. The saved version, not the currently edited Board, governs a Run.

## Work and quota identities

Every request, return, activation, native attempt, cap denial and notice has a different durable ID. All carry the exact workspace, workflow, Run and immutable version scope. Each activation also carries a root `lineageId`, preserved across sibling branches and correlated returns. An accepted new business work request has `requestId`, requester activation and execution, destination node, connection ID, accepted source-result digest and a 1-based ordinal. The logical request key includes both source execution and saved connection, so a finished turn can send work to two independent branches. Its accepted reservation charges one slot, including request #1. An ambiguous native submission is still charged until reconciled; technical retries never reserve a second slot. The counter key is `(run_id, workflow_version_id, relationship_id)`. A new Run starts at zero. Nodes can share several independently counted connections.

The return carries the originating `requestId`, exact requester and reviewer activations, accepted result digest, latest deliverable, remaining findings and `accepted | needs_changes`. It charges nothing. A native result uses typed `routing.kind: request | return | finish` and a named request outcome or exact return request ID. The server maps a named request outcome to a saved edge, checks live grants and capacity, and rejects an invented, forbidden or exhausted target. It never infers routing from prose. Permission and approval exchanges, progress, notices, replays, delivery acknowledgements and technical retries do not charge work slots. Independent reverse work on a `both` connection does.

An activation has its own ID and causal `entry | dependency | join | work_request | work_return | limit_denial` reference. A native attempt belongs to that activation, not merely `(run,node)`. Input bindings keep exact source activation, request, accepted result digest and destination activation. A multi-input `join: all` has one waiting activation keyed by Run, root lineage and destination; distinct incoming requests queue it once only when all required source results have arrived. Intermediate feedback cannot satisfy a downstream dependency; only an exact final accepted export can release an all-required join. The ordinary DAG still determines initial/dependent work. A later work request is admitted as a guarded transition in the **same** engine and Run; the old block occurrence and `blockForNode` are not its identity. There is no arbitrary graph-cycle admission.

| Trigger | Atomic durable transition | Native effect and next state |
| --- | --- | --- |
| New authorized work request, `used < limit` or unset limit | Lock Run/connection; deduplicate request ID and digest; reserve ordinal `used + 1`; publish request and activation intent | Existing owner/session/Stop fences control one destination launch. Reservation remains charged during uncertain delivery. |
| Identical request replay | Return the original receipt | No new activation, native turn or charge. Conflicting digest is rejected. |
| New work request with exhausted connection | Persist one denial and one requester continuation intent; count unchanged | Destination never launches. Requester receives a workflow-owned notice or remains explicitly delivery-unknown. |
| Correlated return with `accepted` | Persist return and result ancestry | Resolve the accepted path. No extra requester wake-up solely because the cap was reached. |
| Final allowed return with `needs_changes` | Persist return plus exhausted-destination notice in the **same** requester activation/continuation | Requester receives review feedback and notice once, and may choose another saved, authorized connection with capacity. |
| Return with remaining work and another slot available | Persist return and one requester continuation | Requester may revise and submit new work; that next request is the next charge. |
| No available authorized route | Persist `needs_direction` for the affected activation | No forged approval or global Stop; independent branches continue. User Stop remains available. |
| Stop or uncertain native delivery | Preserve admission, ownership, session and receipt evidence | No blind native resend or replacement session. Existing settlement/recovery determines a safe next action. |

The exhausted-destination notice text is: “The maximum number of work handoffs to agent C has been reached (3 of 3 for this Run). Choose another available agent or finish with the remaining findings.” `C` and the numbers are rendered from the pinned destination and durable usage. The continuation also contains the exact last deliverable, unresolved findings, causal request/return and server-validated alternatives. The third needs-changes review and notice share one logical wake-up. A later attempted fourth request has its own idempotent denial/notice and no C launch. Repeated automatic denial of the same decision is forbidden.

## API and activity read contract

The existing authenticated definition save/read routes and Operator tools persist and read `handoffs`, `maxWorkHandoffsPerRun` and `workRequestDirection` through the common authoring service. NIM-2695 adds one authorized per-Run handoff projection and Activities read service:

* `GET /api/management/workspaces/:workspaceId/runs/:runId/handoffs` and Operator `run_handoffs_get_v1`: saved connection ID, pinned endpoints/names, nullable cap, Run-wide used count, authorized available destinations, and exact unresolved/continuation state. A nullable cap in this **read** shape represents the absent saved field.
* `GET /api/management/workspaces/:workspaceId/runs/:runId/activities?after=<sequence>&limit=<bounded>` and Operator `run_activities_get_v1`: ascending durable sequence, stable logical ID, timestamp, exact Run/version/Agent/activation/connection references, public kind/severity/status/summary and bounded safe detail, plus high-water and next cursor. Initial and catch-up pages use the same service and authorization. A stale/retained-away cursor produces an explicit resync response.
* Work requests/returns are workflow-origin operations through the existing native/Run authority, not a management write endpoint or Agent-chat send. They require the saved route and the current Run grants. Read-only callers cannot acquire write authority from an Activities or quota read tool.

Activities is an append-only account of what happened, not a second execution-state store. Sequence, rather than timestamp, orders equal-time events. UI catch-up deduplicates by stable logical ID and sequence, bounds retained pages, and clears private rows after confirmed access revocation. Pending approvals stay in the authorized approval inbox. `decided`, delivery pending/failed, native delivered and worker acknowledged are separate states. Draft validation/save warnings stay in Board notices.

| Existing source | Public Activities treatment | Qualification target |
| --- | --- | --- |
| `run_activity` Run/execution lifecycle | Pinned Agent, started/completed/failed/Stop/recovery row, ordered by durable sequence | HTTP/MCP page and restart tests |
| Native producer normalization and native projection | Only redacted public tool/action/log facts backed by native evidence | Redaction and real Codex/OpenCode tests |
| Durable interaction and delivery rows | Decision, queued/pending/failed/delivered and worker acknowledgement as distinct events | Real approval/denied-caller tests |
| Review job and accepted result | Review/return with exact requester, result and causal request | Three-review and return ancestry tests |
| Handoff requests/counters/denials/notices | Accepted ordinal, exhausted notice, delivery, reactivation, reroute, needs-direction | Race, replay, cap, reroute and restart tests |
| Board draft validation/save state | Remains in Board notices; absent from Run Activities | Board save/discard tests |

Provider reasoning, raw prompts/tool arguments, credentials, unobserved logs, estimated progress and standalone Agent chat are not Activities facts. Missing provider detail is displayed as unavailable, never synthesized. NIM-2695 will record the complete producer-to-public-row-to-test mapping after the backend source inventory.

## Migration and deployment

The NIM-2693 forward SQL migration creates `run_work_activations`, `run_work_results`, `run_work_connection_usage`, `run_work_requests`, `run_work_returns` and `run_work_denials`, plus activation-scoped native slot and attempt keys. It does not update historical `workflow_versions`, `runs`, repeat occurrences or accepted results. Notice delivery evidence is added with NIM-2694. Deploy additive schema before admitting marked new Runs. Old in-flight Runs remain pinned to the old definition and existing recovery/Stop path. Old ordinary definitions without `repeat` do **not** acquire unlimited handoff semantics. Existing finite multi-node blocks are never inferred to be one pair. Conversion requires an explicit new authored definition, a new immutable version and a visible explanation of any unsupported mapping; the old version and its Runs stay readable. New workflow creation adopts the marker only when the new engine and UI are ready together.

A definitive cancellation before request admission leaves no counter row or charge. Once the accepted request and reservation commit, later cancellation or uncertain native delivery does not refund that ordinal or erase its ancestry. A new Run alone resets usage.

Run-wide `maxNodeExecutions`, owner/session/Stop gates and technical retry limits remain separate safeguards. Unlimited connection allowance removes only that connection's cap and never creates an automatic loop.
