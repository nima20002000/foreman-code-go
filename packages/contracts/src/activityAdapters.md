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
