Canonical CI artifact adapter
=============================

`createCanonicalJobArtifactPort` constructs the actual CI-B `JobArtifactPort`
(`list` and exact revision `read`) using `PostgresFileRepository`, the existing
allocation/publication tables, and the same private canonical storage root. It
also exposes `publishAccepted` and `verifyRequiredOutputs` for the main receipt
projector. No conversation, Agent or Run is fabricated for a standalone job.

Root composition supplies CI-B's `JobPublicationAuthority` with the actual W08
job-owner fence and approved source/root validation, plus a `TrustedJobOutputReader`.
For remote bytes, `VerifiedJobOutputReader` uses W09-B's verified receipt/open port
and a server-derived `AcceptedJobTransferResolver`. The resolver must locate the
admitted transfer/output intent and current W07 connection, never accept a
worker-supplied transfer ID as authority. Main-local output streams must come from
CI-A's immutable post-closure output collector; do not open the declared relative
output path against the main filesystem. The declaration is metadata.

`publishAccepted(input, source)` is called after the process result is durably
settled, outside the caller's SQL transaction. It opens short authority
transactions, registers canonical allocation ownership, commits the existing
publication link before finalization, stages network bytes without a SQL
transaction, then reauthorizes inside each allocation metadata commit. A lost
finalization acknowledgment recovers the same file/revision receipt without
reopening worker bytes. Changed command bytes/spec/scope conflict. A unique
publication index binds one declared output path to one execution attempt.

The accepted policy snapshots retention and the aggregate output-byte budget.
Allocation guards serialize budget reservations with the canonical job-row lock.
TTL never slides on replay. Canonical expired/removed metadata stays discoverable;
reads fail explicitly instead of substituting latest bytes. Existing tombstone
cleanup now includes job execution scopes. Human document retention preferences
and their apply-to-existing behavior remain limited to their original chat scope.

`verifyRequiredOutputs(sql, execution)` plugs into
`JobWorkerAuthority.verifyPublication`. It checks exact attempt, owner, accepted
spec/output digest, required declarations and live lifecycle, and opens each
canonical object to verify its immutable size/hash before allowing completion.
`JOB_REQUIRED_OUTPUT_MISSING` means a required exact live output is absent/expired.
`JOB_REQUIRED_OUTPUT_CORRUPT` means expected metadata/bytes are missing or fail
integrity. Other infrastructure/auth failures propagate for journal replay.

`CiOutputByteStorage` is a separate explicit capability for the allowlisted
`ci-output` revision class. Its 25 MiB class validates UTF-8 text, JSON syntax,
existing safe ZIP structure, gzip CRC/bounded expansion, and declared generic
binary outputs. The document `FileRevisionSchema`, upload MIME/extensions and
archive policy are unchanged. The default document byte capability refuses CI
revisions; conversation tools/reference resolution deny job execution scope.
HTTP downloads are attachment-only through CI-B; its MCP reader has the existing
1 MiB response limit and advertises exact HTTP readback for larger artifacts.

Integrate `jobArtifactStorageMigration` (285202) after jobs/file storage/file tools
migrations, CI-B's scope/grant contract patch and the `jobs`/`job-artifacts` exports.
Root's approved native document guards are supplied separately in
`/tmp/graphql-workstream-20261001/patches/w09-c-job-document-native-guards.patch`.
They must not be omitted when the shared metadata union expands.

Focused checks:

```sh
corepack pnpm --filter @graphql/api exec vitest run \
  test/job-artifacts.test.ts test/job-document-isolation.test.ts \
  test/file-storage.test.ts test/codex-file-delivery.test.ts test/file-tools.test.ts \
  --maxWorkers=1
```

`test/job-artifacts-postgres.integration.test.ts` is the root-only runnable DB
fixture: actual storage/allocation/publication persistence, live hashed credential
authentication, the CI HTTP routes and SDK MCP tools, denied callers, pinned
readback, receipt counts and owner revocation/expiry. Its explicit owner/root SQL
fixture proves the adapter contract, not a qualified two-host/container install.
This lane does not launch integration or physical acceptance.
