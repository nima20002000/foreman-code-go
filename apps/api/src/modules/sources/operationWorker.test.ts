import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { SourceRootRecord, SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import type { SourceFilesystemOperation, SourceOperationOwner } from '@graphql/contracts/source-operations'
import type { VerifiedTransferReceipt, TransferContext } from '@graphql/contracts/byte-transfer'
import { sourcePackageHeader } from './operationPackage.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { qualifyApprovedRootAllowlist } from './rootAttestation.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceBindingHash } from './bindingHash.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { sourceCwdAttestationDigest } from './workingDirectory.js'
import { SourceOperationWorkerService } from './operationWorker.js'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp('/tmp/source-rpc-'); directories.push(directory)
  const runtime = join(directory, 'runtime'), base = join(directory, 'projects'); await mkdir(runtime, { mode: 0o700 }); await mkdir(base, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, applicationInstallationId: binding.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const policyId = randomUUID(), parent = join(runtime, 'source-materializations'), namespace = join(parent, policyId); await mkdir(parent, { mode: 0o700 }); await mkdir(namespace, { mode: 0o700 })
  const handle = await openPrivateRoot(namespace); const filesystem = await identity(handle); await handle.close()
  const bytes = Buffer.from('export const actual = true\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(), capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'src/source.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const source = { snapshotId: manifest.snapshotId, approvedSourceId: manifest.approvedSourceId, manifestDigest: manifest.manifestDigest }
  const root: SourceRootRecord = { version: 1, source, selection: { hostRef: roots.hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, workspaceId: 'workspace-actual-fixture', mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId, rootId: randomUUID(), bindingRevision: 1,
      locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    ownerPrincipalId: 'principal-human-fixture', authorizedByPrincipalId: 'principal-preparation-fixture', registration: { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    attestationId: randomUUID(), attestationDigest: 'b'.repeat(64), boundAt: new Date().toISOString() }
  const operationId = randomUUID(), attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '', keyRevision: 1, authorizationRevision: 1 }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  expect(sourceOperationSelectionHash(root, attempt, operationId)).toBe(attempt.placementHash)
  const owner: SourceOperationOwner = { identity: { operationId, ownerPrincipalId: root.authorizedByPrincipalId, expiresAt: new Date(Date.now() + 120_000).toISOString() }, root, attempt, source, record: null, physicalClosureConfirmed: false }
  const data = Buffer.concat([sourcePackageHeader(manifest), bytes]), transferId = randomUUID(), receiptId = randomUUID()
  const transferContext = { ...binding, connectionEpoch: binding.connectionEpoch } as TransferContext
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId, transferId, sha256: sourceSha256(data), byteSize: data.length, verifiedAt: new Date().toISOString(), intent: {
    ...transferContext, version: 1, transferId, operationId, executionId: attempt.executionId, attemptId: attempt.attemptId, placementHash: attempt.placementHash,
    rootId: root.binding.rootId, rootBindingRevision: 1, direction: 'to-worker', byteClass: 'source', manifestDigest: manifest.manifestDigest,
    expiresAt: owner.identity.expiresAt, chunkBytes: 1024 * 1024, sha256: sourceSha256(data), byteSize: data.length } }
  // B context contains only its canonical fields, not W07 connectionGeneration.
  delete (receipt.intent as unknown as Record<string, unknown>).connectionGeneration; delete (transferContext as unknown as Record<string, unknown>).connectionGeneration
  const request: SourceFilesystemOperation = { version: 1, operation: 'sources.prepare', identity: owner.identity, root, attempt, package: { transferId, receiptId, sha256: receipt.sha256, byteSize: data.length } }
  const readRoots = vi.fn(async () => roots), open = vi.fn(async () => Readable.from([data]))
  const currentOwner = vi.fn(async () => structuredClone(owner))
  const service = new SourceOperationWorkerService({ authenticate: async () => {}, approvedRoots: readRoots, currentOwner,
    transfers: { resolveVerifiedReceipt: async () => receipt, openVerified: open }, transferContext: async () => transferContext })
  const context = { binding, signal: new AbortController().signal }
  return { directory, runtime, namespace, data, bytes, manifest, root, owner, request, receipt, context, service, currentOwner, readRoots, open }
}
it('prepares actual accepted bytes, rechecks owner before activation, and recovers lost ACK without new transfer', async () => {
  const f = await fixture(), response = await f.service.handle(f.request, f.context)
  expect(response.operation).toBe('sources.prepare'); if (response.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  expect(await readFile(join(f.namespace, response.receipt.materializationId, 'tree/src/source.ts'))).toEqual(f.bytes)
  expect(f.currentOwner.mock.calls.length).toBeGreaterThan(3)
  expect(await f.service.handle(f.request, f.context)).toEqual(response); expect(f.open).toHaveBeenCalledTimes(1)
})
it('verifies and creates genuine detached private Git, replays repository receipt, and requires positive Main closure', async () => {
  const f = await fixture(), result = await f.service.handle(f.request, f.context)
  if (result.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: result.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: 'c'.repeat(64), state: 'prepared' }
  f.owner.record = record
  const verified = await f.service.handle({ version: 1, operation: 'sources.verify', record }, f.context); expect(verified.operation).toBe('sources.verify')
  const repository = await f.service.handle({ version: 1, operation: 'sources.private-repository', record }, f.context)
  expect(repository.operation).toBe('sources.private-repository')
  if (repository.operation !== 'sources.private-repository') throw new Error('wrong fixture operation')
  expect(repository.repository.generatedCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(await f.service.handle({ version: 1, operation: 'sources.private-repository', record }, f.context)).toEqual(repository)
  await expect(f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)).rejects.toThrow('positively confirmed')
  f.owner.physicalClosureConfirmed = true
  expect((await f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)).operation).toBe('sources.release')
})
it('denies stale auth/expired ownership before local config or source package IO', async () => {
  const f = await fixture(); f.owner.identity.expiresAt = new Date(Date.now() - 1).toISOString()
  await expect(f.service.handle(f.request, f.context)).rejects.toThrow('current exact')
  expect(f.readRoots).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
})
it('rejects corruption before activating a ready tree and rejects root replacement', async () => {
  const f = await fixture(); f.data[f.data.length - 1] = 120
  await expect(f.service.handle(f.request, f.context)).rejects.toThrow('accepted manifest')
  const other = await fixture(); await rename(other.namespace, `${other.namespace}-original`); await mkdir(other.namespace, { mode: 0o700 })
  await expect(other.service.handle(other.request, other.context)).rejects.toThrow('changed')
})
it('rejects another actual operation/owner/root and caller binary/source-path shortcuts', async () => {
  const f = await fixture()
  if (f.request.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  await expect(f.service.handle({ ...f.request, identity: { ...f.request.identity, operationId: randomUUID() } }, f.context)).rejects.toThrow('original source')
  await expect(f.service.handle({ ...f.request, path: '/home/other' }, f.context)).rejects.toThrow()
  await expect(f.service.handle(f.request, { ...f.context, bytes: Buffer.from('shortcut') })).rejects.toThrow('inline binary')
  expect(f.open).not.toHaveBeenCalled()
})

it('attests a real opened child separately from the tree and rejects traversal and symlink replacement', async () => {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  f.owner.record = record
  const response = await f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)
  if (response.operation !== 'sources.verify') throw new Error('wrong fixture operation')
  expect(response.canonicalCwd).toBe(join(response.workTree, 'src'))
  expect(response.filesystem.inode).not.toBe(record.receipt.localTreeIdentity.inode)
  expect(response.cwdAttestation.filesystem).toEqual(response.filesystem)
  expect(response.cwdAttestation.attestationDigest).toBe(sourceCwdAttestationDigest(response.cwdAttestation))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: '../src' }, f.context)).rejects.toThrow()
  await rename(join(response.workTree, 'src'), join(response.workTree, 'old-src'))
  await symlink('old-src', join(response.workTree, 'src'))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)).rejects.toThrow()
})
