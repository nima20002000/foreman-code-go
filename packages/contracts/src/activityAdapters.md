Activity v1 adapters (NIM-2825)

AgentChatState keeps its legacy numeric revision and activeTurn shape. The additive
activitySnapshot uses exact decimal scope/item revisions. Legacy activeTurn falls
back to immutable receipt creation time for pre-migration records; activitySnapshot
startedAt remains null for those records rather than inventing admission time.

Existing conversation records adapt into public tools/subagents/reasoning summaries
using the strict existing title allowlist; input/output are omitted. Proven native
identity on active work comes from the persisted conversation binding. Older item
records have unknown observation time and source system conversation_record.

PendingNativeInteraction is an ephemeral native callback object, not a durable
interaction receipt. It supplies waiting phase but does not fabricate an
InteractionSummary. C's durable interaction read adapter supplies those summaries.

Run Activities retain their existing stricter public projection and cursor windows;
this chat adapter never treats selected Run origin as writable execution ownership.
The new notification envelope is not another persisted event store.

Root must register activitySnapshotMigration (version 282501) after agentChatMigration,
and apply w05-a-contract-wiring.patch to shared contract exports/state schema.
Integration tests are authored for orchestrator execution; no HTTP/MCP restart or
native qualification is claimed by these unit fixtures.

Completion adapters (NIM-2825)

Operator getWithActivity reads legacy state, texts/files and the canonical snapshot
inside one repeatable-read transaction. Agent snapshots include persisted text,
separate message/activity order namespaces, native part/channel identity and
receipt-backed finalized file publications. History messages expose exact decimal
record revision and their real message-table sequence. Text ordering across the
activity table uses the existing afterActivitySequence predecessor; the two table
sequences are never mislabeled as one global order or provider source sequence.

Run snapshots have a workflow_run scope, genuine Run/execution owners and an
explicit sourceRevisions vector. The Run record revision is not the revision of
all executions. readRunActivitySnapshot validates the complete before/after vector
(run, execution, native records, audit and interaction/worker acknowledgment)
for existing READ COMMITTED callers. A moving vector produces a scoped refresh
conflict. Raw prompts, paths, commands, tool arguments and provider text stay out
of this Run adapter. Existing audit bounds remain intact.

Public text operations commit before stream coalescing. Provisional append requires
actual native sequence or an identified transport connection plus its actual
sequence. Transport order is private provenance, not a durable or native sequence.
Unknown/cross-connection conflicts request reconciliation; exact session/turn/
request and selected origin are checked inside the message-row transaction. Final
replacement can be shorter or empty, and late provisional text cannot reverse it.

Chat interaction summaries refer to the existing persisted native callback pointer
using a stable composite projection ID. This does not create a durable workflow
interaction receipt. A submitted response fence is not recorded answer, delivered
answer or worker acknowledgment. C qualifies live response availability separately.

Register activitySourcesMigration (282502) after activitySnapshotMigration. Shared
Message-schema wiring is in w05-a-completion-message-schema.patch. DB/native/HTTP/
MCP/reload/restart qualification is executed by the root orchestrator.

Publication status projects its immutable finalized receipt and persisted catalog
state. Existing attachment lifecycle and file endpoints qualify download eligibility,
including expiry. Mutable file state contributes its own record revision vector.
