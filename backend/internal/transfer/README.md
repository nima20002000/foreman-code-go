# Private byte staging primitives

This is the contract-independent first part of the byte-transfer port. The
behavior comes from the frozen TypeScript `byte-transfer/service.ts` at
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`: private Linux directories, safe
regular part files, bounded chunks, committed-prefix checking, uncommitted-tail
truncation, duplicate comparison, data fsync and full SHA-256 checking.

`StagingDirectory` pins each ancestor while opening the private root. File
operations use the original directory/file descriptors, so an ancestor rename
cannot redirect a write. Symlinks, multiply linked files, non-private files and
unsafe ancestor ownership or permissions fail closed. No method deletes a part
file or silently releases ownership, admission or quota.

`OpenPart` accepts a local filename stem and explicit byte/chunk limits. These
are filesystem inputs, not transfer domain contracts. The eventual receiver
must validate its generated transfer intent and policy, authorize the current
caller, acquire the canonical transfer/allocation ownership, and then call these
primitives. `SyncChunk` takes the offset and digest from that receiver's durable
journal. Its result means that data fsync succeeded; the receiver must still
persist and fsync its progress journal and directory before acknowledging data.
`Verify` rechecks complete bytes and does not issue a verified receipt.

These primitives serialize one open handle; they are not the cross-process
ownership implementation. The full generated-contract receiver, persistent
journals, quotas, authorization, reader pins, external reservations, publication
adapters, rsync and recovery supervision remain separate unfinished work. No
routes, tools or worker capabilities are registered by this package.

The exact merged base `7fa547058109519a99c904493c916662fde6a474` does not yet
contain the Go contract export. Before the receiver can be implemented, owner I
must provide generated `TransferIntent`, `TransferContext`, `TransferProgress`,
`VerifiedTransferReceipt`, `BYTE_TRANSFER_POLICY` and their schema validators
from `packages/contracts/src/byteTransfer.ts`, plus the import path. This package
does not copy those shapes or policy values.

Behavior tests use fresh temporary roots and observable bytes, digests and
failures. All test/build/lint/format execution belongs to the terminal controller
through affected-scope Foreman CI MCP. Authored tests are unrun until the
controller provides a ticket and results. Current conformance has no byte
staging scenario; Q-CONF owns adding its black-box coverage. Existing S source
catalog/root scenario IDs do not establish this package's behavior.
