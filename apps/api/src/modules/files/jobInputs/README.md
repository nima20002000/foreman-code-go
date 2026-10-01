# Immutable accepted job inputs

`createCanonicalJobInputPorts` constructs the SQL authority, original admission
receipt and canonical byte reader from the existing pool, FileByteStorage,
PostgresJobDispatch, accepted-source preparation and current W07 endpoint. Its
`validateDeclaredJobInputs(sql, principal, workspaceId, inputs)` performs real
SQL-only definition/Start validation, including empty inputs. It must run before
source preparation. `local.prepare` implements the required executor input port.

For devices, register `extension` on the actual W07 server and construct
`createWorkerJobInputPort` with the existing signed application channel plus its
actual current authenticated binding accessor. Main-owned intents and exact
canonical ranges use namespace `job-inputs-v1`; the worker uses the existing
ResumableByteTransferService for verified staging. No worker SQL or management
principal is delivered. Current recipient dispatch/source/root, sender scope,
source result binding, device credential and file expiry are checked again.

The persisted original binding uses management_command_receipts, operation
`job.inputs.bind`. Register the root-owned immutable receipt migration patch.
The manifest exposes only exact file pins and accepted workflow JSON. The
security receipt must be kept in a private main/worker host directory outside
all build mounts. `.graphql-job-inputs` cannot replace an existing source path.
Its returned receipt requires CI-B's actual readonly OCI bind before native
entry; file modes are an additional check, not the readonly authority.

Partial copies fail closed and cannot be overwritten. Verified staging remains
charged until B's bounded expiry cleanup; private retained input copies remain
charged under the original source volume claim until proven process closure and
root-owned cleanup. No TTL deletion of a potentially running source is added.

Focused invocation:
`corepack pnpm --filter @graphql/api exec vitest run test/job-input-delivery.test.ts test/job-input-channel.test.ts --maxWorkers=1`

Root still owns PostgreSQL/authenticated HTTP-MCP persisted-readback execution,
production composition, CI-B readonly-mount/native proof and physical acceptance.
