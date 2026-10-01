# W09 bounded staging port

`ResumableByteTransferService` is a receiver, not a listener, scheduler, publication
service or Run completion signal. W07 must negotiate `resumable-binary-transfer-v1`
and supply a binary chunk separately from its bounded metadata. Never JSON/base64
encode bulk bytes. Sender waits for each append result; do not queue chunks.
W07 owns control priority, backpressure, TLS and the single connection supervisor.

Production must provide a private Linux staging root outside source/working trees,
and `TransferAuthorization.authorize`. The hook must recheck current device
revocation/key/authorization revision, boot/epoch against W07's authenticated
connection, W08's exact accepted operation/execution/attempt and placement, A's
current root binding, and capability expiry on every operation. The origin
boot/epoch in the immutable intent are provenance; reconnect uses a new **current**
context authenticated by W07. The hook cannot be a permissive no-op. Main must
persist its authorized immutable intent before handing it to this receiver.

Caps are shared in `BYTE_TRANSFER_POLICY`: <=1MiB negotiated chunks, <=128MiB source
objects, existing 25MiB artifacts, 2 active/device, 4 globally, <=512MiB staging,
4096 records, <=1h lifetime, 5min unfinished idle deadline. Verified bytes still
reserve staging until main publication/adoption acknowledgment is reconciled.
Do not cancel the only producer copy before canonical commit. Source manifests
and archive expansion use A's independent entry/expansion budgets; staging is not
a document validation bypass. C must stream `openVerified` through the existing
full-upload validator/allocation/finalize/publication service for artifacts.

Data fsync precedes atomic checksummed progress journal replacement and directory
fsync, which precede ACK. Duplicate committed ranges are read back and compared.
Each resume checks the durable prefix and truncates only uncommitted tails.
Missing/corrupt committed bytes fail closed; C must cancel/restart the byte attempt
under the same accepted logical operation. Final SHA256 and byte count are checked
independently, including on repeated finish after lost ACK. `resolveVerifiedReceipt`
uses local authoritative records; submitted receipts cannot create verified state.
`openVerified` verifies the complete object and reauthorizes each bounded read.

Private directory FD paths on Linux anchor runtime operations against ancestor
rename/swap. Ancestors must be owned by root or the service uid and not writable
by others except sticky directories. The root and files must be private/service
owned; files must be regular, singly linked and opened with O_NOFOLLOW. Peers must
not run under the service uid or possess its private directory descriptor. This
is not a security boundary against a compromised service uid.

Per-transfer and allocation directory locks reject competing writers across
receiver processes. Crash-left `.lock` directories fail closed. The supervising
owner must confirm its prior process is dead before removing stale locks; no
age-only stealing. Journals and uncommitted part files survive restart.
`cleanupExpired(1..64)` bounds tombstone/deletion batches. C invokes trusted
`retire(id)` for confirmed revocations and invokes cleanup from its existing
cleanup supervisor. Tombstones precede unlink; retries do not extend file lifetime.
Canceled records retain conflict identity until a separately authorized retention
policy removes them. No worker database or native recovery journal is involved.

Focused commands (from root; verbose output should go outside Git):

```
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/contracts exec vitest run src/byteTransfer.test.ts
corepack pnpm --filter @graphql/api exec vitest run src/modules/byte-transfer/service.test.ts
corepack pnpm --filter @graphql/api typecheck
```

Fault hook supports `data-sync`, `journal-sync`, `directory-sync`; rejecting a hook
simulates EIO/ENOSPC/fsync failure before the corresponding durability boundary.
No new runtime dependency was selected. Existing pinned Node filesystem/crypto and
Zod are used. No claim is made about optional rsync/rclone advisories or two-host
qualification: they are not used here.

Outstanding orchestrator acceptance: actual W07 binary carrier negotiation and
control/Stop/heartbeat fairness; authenticated endpoint denied/readback coverage;
main persisted intent and C publication/retention wiring; source immutable sender
adapter; real two-process crash-lock reconciliation; peak memory and aggregate
quota calibration; actual ENOSPC/EIO; real PC/laptop source/edge execution after
W07-HUMAN approval. These unit ports alone do not close those live gates.
