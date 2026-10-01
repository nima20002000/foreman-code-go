# Remote operation ownership checkpoint

This journal is a worker-side durability boundary, not a scheduler and not a database client. Production wiring must use the W07 authenticated application carrier, accepted placement/operation scopes, existing main Run owner, W01 native managers, and W11 recovery/closure evidence. These files do not establish that a native two-host Run has executed.

| Phase | Durable fact | Permitted next action |
| --- | --- | --- |
| received | exact original intent accepted | one serialized entry reservation, or Stop fence |
| native_entry_attempted | reservation persisted before native invocation | query original provider; never repeat Start |
| start_acknowledged | original session/turn/process identity retained | observe same execution |
| running | original execution acknowledged running | scoped exact Stop/respond |
| stop_requested | negative fence and command persisted | cancel original owner; wait for physical closure |
| confirmed_terminal | exact closure evidence and optional result digest | main-owned canonical result/edge transaction |
| uncertain | acknowledgment/process/journal knowledge insufficient | original-host reconciliation only |

`accept`, `reserveEntry`, `control`, and owner reconciliation return only after file fsync, atomic rename and directory fsync. Any write uncertainty poisons the current journal instance. Duplicate dispatch can query the same receipt but cannot reserve another entry. A dispatch lease is deliberately absent: it cannot confer native authority. `control` returning `dispatch:false` for duplicates means observation/reconciliation, never an external-effect retry. A response reserves one exact recorded native question; lost response acknowledgment remains a query of that original native question, not a resubmission. W01's NativeResponseJournal remains responsible for native delivery evidence.

New installation initialization is explicit. Missing/corrupt storage on an established installation fails closed. The exclusive owner-lock is not PID based; a crash retains it. A human/W11 recovery adapter must establish original process/provider ownership before disposing of a stale lock. Do not unlink it just because a heartbeat expired. `close()` is a clean local owner handoff, not evidence the provider execution died.

Retention is bounded by 1000 operations (configurable lower/higher explicit capacity), 128 controls per operation, 128 owner renewals total, and 4 MiB serialized journal. There is no automatic expiry or pruning of unresolved work or terminal deduplication tombstones. A full journal rejects new acceptance until explicit audited retention disposition establishes a safe archival boundary. Rejected main reports go to a bounded recovery audit port and cannot modify canonical execution or publish an edge.

The main `VerifiedRemoteEvidence.commit` boundary must run within the existing execution/canonical transaction. `authority()` must lock/read the current Run execution, placement, registered-worker identity, original connection/incarnation, grant scopes/revocation, current reconciled owner and sequence, original native identity and committed terminal evidence. `accept()` atomically persists the receipt/sequence and canonical result + eligible edge via existing writers. It must independently verify closure/artifact attestations using W11/W09 services; a transport-supplied digest is a correlation reference, not trusted native evidence. Do not cast this evidence to a trusted in-process capture. Renewal is the same original physical execution, requires exact native recovery evidence and increments owner epoch; it never reserves another Start.

Recovery calls, through the authenticated scoped application carrier (not SSH or SQL):

1. `journal.status(operationId)` on the original registered worker.
2. If entry was attempted, query W01/W11 for the recorded operation, installation, boot, process identity, session and turn. An absent journal returns `unknown`, not `not_started`.
3. `journal.acknowledgeStart(operationId, provenNativeIdentity)` only after original-host proof; otherwise `journal.uncertain(operationId, redactedReason)`.
4. Main owner restart: `journal.reconcileOwner({ commandId, operationId, previousOwner, nextOwner, native, evidenceDigest })`, with live grant validation and audited main transition in the authoritative adapter.
5. `journal.terminal(operationId, verifiedClosureEvidence)`; main then uses `VerifiedRemoteEvidence.commit` and reads persisted canonical/edge records back. Neither a cancellation request nor PID absence is closure evidence.

Redacted example: `{operationId:"op-…", attemptId:"attempt-…", bindingHash:"<sha256>", phase:"uncertain", entryAttempted:true, native:{sessionId:"session-…",turnId:"turn-…",processIdentityDigest:"<sha256>"}, uncertainty:"provider acknowledgment unavailable; original owner retained"}`. No provider login, application credential, DATABASE_URL or admin token belongs in a receipt.

Remaining release gates: root's main persistence/transaction and HTTP/MCP permission/denial/readback integration; W07's scoped dispatch/control/status carrier (current canonical carrier exposes no execution dispatch); HRT-B/W01 native manager ownership bridge; W11 validated process-tree/provider closure; W09 real edge/artifact publication; orchestrator-only actual PC→laptop and fault suites. No remote command-line executable or real-device recovery is claimed by this checkpoint.
