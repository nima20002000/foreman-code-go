# Workflow runtime timing

Set `LOG_LEVEL=debug` to emit `runtime-timing` diagnostics through the existing API
logger. They contain phase names, timestamps, durations, and Run, execution,
native-session, or process-owner identifiers. They exclude prompts, model text,
SQL bodies, credentials, and environment values.

In-process diagnostic collectors can subscribe to the Node diagnostics channel
`foreman-code.runtime-timing`. Observers must return immediately and must not
throw. The native acceptance runner retains these records in its scenario
artifact, with a count if its bounded collector drops records.

Start and native-submission points locate the beginning of a Run and its turns.
Native event points identify first and last message deltas and terminal events.
Other phases measure worker admission, connection queueing, SQL calls, persisted
lease checks and renewal, batch reads and publication, reconcile backoff, terminal
acceptance, settlement, process closure, and Run cleanup. Heartbeat and batching
intervals are recorded without changing them. RPC records include their deadline,
so a deadline can be distinguished from an interval actually spent waiting.

Spans overlap. Do not add their durations as elapsed Run time: a healthy wrapper
can wait for a provider while heartbeats and persistence proceed concurrently.
For a critical-path breakdown, merge interval ranges, compare native output and
terminal timestamps with the original provider rollout, and separately account
for application work before submission and after the native terminal. An open
provider turn does not by itself prove that every second is irreducible provider
work; stream backpressure must be checked against event-read and persistence spans.
