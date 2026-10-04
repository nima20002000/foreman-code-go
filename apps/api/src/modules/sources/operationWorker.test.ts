import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { SourceRootRecord, SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import type { SourceActiveNativeSession, SourceFilesystemOperation, SourceOperationOwner } from '@graphql/contracts/source-operations'
import type { SourceInstalledNativeOwner } from './executionHosts.js'
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
  const nativeOwnerFor = vi.fn(async (): Promise<SourceInstalledNativeOwner | null> => null)
  const preparationNativeClosed = vi.fn(async () => true)
  const preparationTransfersClosed = vi.fn(async () => {})
  const service = new SourceOperationWorkerService({ authenticate: async () => {}, approvedRoots: readRoots, currentOwner,
    transfers: { resolveVerifiedReceipt: async () => receipt, openVerified: open }, transferContext: async () => transferContext,
    nativeOwnerFor, preparationNativeClosed, preparationTransfersClosed })
  const context = { binding, signal: new AbortController().signal }
  return { directory, runtime, namespace, data, bytes, manifest, root, owner, request, receipt, context, service, currentOwner,
    readRoots, open, nativeOwnerFor, preparationNativeClosed, preparationTransfersClosed }
}

it('confirms preparation cleanup only after native closure and transfer reservations are released', async () => {
  const f = await fixture()
  f.owner.preparationClosed = true
  const request = { version: 1, operation: 'sources.reconcile-preparation', reconciliationId: randomUUID() }
  f.preparationNativeClosed.mockResolvedValue(false)
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  expect(f.preparationTransfersClosed).not.toHaveBeenCalled()
  f.preparationNativeClosed.mockResolvedValue(true)
  f.preparationTransfersClosed.mockRejectedValueOnce(new Error('Transfer cleanup incomplete'))
  await expect(f.service.handle(request, f.context)).rejects.toThrow('Transfer cleanup incomplete')
  const response = await f.service.handle(request, f.context)
  expect(response).toMatchObject({ operation: request.operation, closure: {
    operationId: f.owner.identity.operationId, executionId: f.owner.attempt.executionId,
    claimReleased: true, childrenClosed: true, evidencePreserved: true,
  } })
  expect(f.preparationTransfersClosed).toHaveBeenCalledTimes(2)
})

async function continuationFixture() {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: 'c'.repeat(64), state: 'prepared' }
  f.owner.record = record
  const cwd = await f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)
  if (cwd.operation !== 'sources.verify') throw new Error('wrong fixture operation')
  const proof: SourceActiveNativeSession = { version: 1, executionId: record.receipt.executionId, runId: randomUUID(), technicalAttempt: 3,
    attemptId: record.receipt.attemptId, operationId: record.operationId, materializationId: record.receipt.materializationId,
    sourceBindingHash: record.sourceBindingHash, finalDispatchBindingHash: record.finalDispatchBindingHash!,
    nativeSession: { harness: 'codex', nativeSessionId: randomUUID(), providerVersion: 'test-current-version' }, generation: 2,
    cwdAttestation: cwd.cwdAttestation,
    entry: { sourceId: randomUUID(), sourceDigest: `sha256:${'d'.repeat(64)}`, launchDigest: `sha256:${'e'.repeat(64)}` },
    owner: { grantId: randomUUID(), epoch: '1' }, lane: { id: randomUUID(), revision: 3, tokenHash: 'f'.repeat(64), expiresAt: f.owner.identity.expiresAt } }
  const lifetime = new AbortController(), assertCurrent = vi.fn(async () => {})
  const installed: SourceInstalledNativeOwner = { executionId: proof.executionId, runId: proof.runId, technicalAttempt: proof.technicalAttempt,
    attemptId: proof.attemptId, operationId: proof.operationId, materializationId: proof.materializationId, sourceBindingHash: proof.sourceBindingHash,
    finalDispatchBindingHash: proof.finalDispatchBindingHash, session: structuredClone(proof.nativeSession), owner: structuredClone(proof.owner), signal: lifetime.signal, assertCurrent }
  f.nativeOwnerFor.mockResolvedValue(installed)
  const tree = join(f.namespace, record.receipt.materializationId, 'tree')
  return { ...f, record, proof, installed, lifetime, assertCurrent, tree }
}
it('preserves strict pre-entry bytes and permits edits only on the same current entered installed native owner', async () => {
  const f = await continuationFixture()
  const request = { version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }
  await f.service.handle(request, f.context)
  const edited = Buffer.from('export const editedByActualOwner = true\n')
  await writeFile(join(f.tree, 'src/source.ts'), edited)
  await writeFile(join(f.tree, 'src/new-output.ts'), 'actual owner output\n')
  await expect(f.service.handle(request, f.context)).rejects.toThrow()
  expect(f.nativeOwnerFor).not.toHaveBeenCalled()
  f.owner.activeNativeSession = f.proof
  const result = await f.service.handle(request, f.context)
  expect(result.operation).toBe('sources.verify')
  expect(await readFile(join(f.tree, 'src/source.ts'))).toEqual(edited)
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(f.open).toHaveBeenCalledTimes(1)
})
it('keeps source verification valid while the same native writer renews its lease', async () => {
  const f = await continuationFixture()
  f.owner.activeNativeSession = f.proof
  f.currentOwner.mockImplementation(async () => {
    f.proof.lane.revision++
    f.proof.lane.expiresAt = new Date(Date.parse(f.proof.lane.expiresAt) + 1000).toISOString()
    return structuredClone(f.owner)
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context))
    .resolves.toMatchObject({ operation: 'sources.verify' })
})

it.each(['token', 'generation', 'revision', 'expiry'] as const)('rejects a changed native %s while refreshing source authority', async change => {
  const f = await continuationFixture()
  f.owner.activeNativeSession = f.proof
  let reads = 0
  f.currentOwner.mockImplementation(async () => {
    if (++reads === 2) {
      if (change === 'token') f.proof.lane.tokenHash = 'a'.repeat(64)
      if (change === 'generation') f.proof.generation++
      if (change === 'revision') f.proof.lane.revision--
      if (change === 'expiry') f.proof.lane.expiresAt = new Date(Date.parse(f.proof.lane.expiresAt) - 1000).toISOString()
    }
    return structuredClone(f.owner)
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
})
it.each(['attempt', 'technical-attempt', 'session', 'owner', 'expiry', 'missing-installed', 'aborted'] as const)('denies mutable continuation with %s evidence', async defect => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  await writeFile(join(f.tree, 'src/source.ts'), 'edited\n')
  if (defect === 'attempt') f.installed.attemptId = randomUUID()
  if (defect === 'technical-attempt') f.installed.technicalAttempt++
  if (defect === 'session') f.installed.session.nativeSessionId = randomUUID()
  if (defect === 'owner') f.installed.owner.epoch = '2'
  if (defect === 'expiry') f.proof.lane.expiresAt = new Date(Date.now() - 1).toISOString()
  if (defect === 'missing-installed') f.nativeOwnerFor.mockResolvedValue(null)
  if (defect === 'aborted') f.lifetime.abort(new Error('original owner closed'))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record }, f.context)).rejects.toThrow()
})
it('rejects current proof revocation during FD verification and symlink/root/tree replacement', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  f.assertCurrent.mockImplementation(async () => { if (f.assertCurrent.mock.calls.length === 4) f.lifetime.abort(new Error('revoked during FD verification')) })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record }, f.context)).rejects.toThrow('revoked during')
  const child = await continuationFixture(); child.owner.activeNativeSession = child.proof
  await rename(join(child.tree, 'src'), join(child.tree, 'original-src')); await symlink('original-src', join(child.tree, 'src'))
  await expect(child.service.handle({ version: 1, operation: 'sources.verify', record: child.record, relativeCwd: 'src' }, child.context)).rejects.toThrow()
  const tree = await continuationFixture(); tree.owner.activeNativeSession = tree.proof
  await rename(tree.tree, `${tree.tree}-original`); await mkdir(tree.tree, { mode: 0o700 })
  await expect(tree.service.handle({ version: 1, operation: 'sources.verify', record: tree.record }, tree.context)).rejects.toThrow('identity changed')
  const root = await continuationFixture(); root.owner.activeNativeSession = root.proof
  await rename(root.namespace, `${root.namespace}-original`); await mkdir(root.namespace, { mode: 0o700 })
  await expect(root.service.handle({ version: 1, operation: 'sources.verify', record: root.record }, root.context)).rejects.toThrow('root changed')
})
it('retains opened CWD identity and rejects replacement while reauthorizing the original native owner', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  f.assertCurrent.mockImplementation(async () => {
    if (f.assertCurrent.mock.calls.length === 4) {
      await rename(join(f.tree, 'src'), join(f.tree, 'original-src'))
      await mkdir(join(f.tree, 'src'), { mode: 0o700 })
    }
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context)).rejects.toThrow('Working directory changed during')
})
it('rejects a replaced child CWD between continuation requests using its original native entry attestation', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  await rename(join(f.tree, 'src'), join(f.tree, 'original-src'))
  await mkdir(join(f.tree, 'src'), { mode: 0o700 })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context)).rejects.toThrow('original entered native directory')
})
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
  const released = await f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)
  expect(released.operation).toBe('sources.release')
  if (released.operation !== 'sources.release') throw new Error('wrong fixture operation')
  expect(released.retainedBytes).toBeGreaterThan(0)
  expect(released.retainedBytes).toBeLessThan(1024 * 1024)
  expect(await f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)).toEqual(released)
})
it('reports bounded repository deadline and incomplete-owner codes without publishing or rebuilding', async () => {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  f.owner.record = record
  const request = { version: 1 as const, operation: 'sources.private-repository' as const, record }
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('private /source/path', 'TimeoutError')))
  try { await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-repository-timeout', message: 'Private source preparation timed out.' }) }
  finally { timeout.mockRestore() }
  await mkdir(join(f.namespace, record.receipt.materializationId, 'repository'), { mode: 0o700 })
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-repository-uncertain' })
  await expect(readFile(join(f.namespace, record.receipt.materializationId, 'repository-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
