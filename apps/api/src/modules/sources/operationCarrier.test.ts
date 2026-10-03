import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { TransferIntentSchema } from '@graphql/contracts/byte-transfer'
import { SourceMaterializationRecordSchema, type SourceRootRecord } from '@graphql/contracts/source-admission'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { CarrierRemoteSourceMaterializationHost, createMainSourceOperationExtension } from './operationCarrier.js'
import { DeviceApplicationError } from '../devices/deviceApplicationChannel.js'

function fixture() {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const intent = TransferIntentSchema.parse({ version: 1, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: binding.bootId,
    connectionEpoch: binding.connectionEpoch, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(),
    attemptId: randomUUID(), rootId: randomUUID(), rootBindingRevision: 1, placementHash: 'a'.repeat(64), direction: 'to-worker',
    byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 4, manifestDigest: 'c'.repeat(64), chunkBytes: 8192,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const record = SourceMaterializationRecordSchema.parse({ receipt: { version: 1, materializationId: randomUUID(),
    binding: { version: 1, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
      workspaceId: 'workspace', rootId: intent.rootId, bindingRevision: 1, locationRevision: 1, canonicalPath: '/original/namespace',
      filesystem, accessMode: 'exclusive-write', snapshotId: randomUUID(), manifestDigest: intent.manifestDigest },
    placementHash: intent.placementHash, executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: 1, authorizationRevision: 1,
    verifiedManifestDigest: intent.manifestDigest, verifiedEntries: 1, verifiedBytes: 4, verifiedAt: new Date().toISOString(), localTreeIdentity: filesystem },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: intent.operationId, reservationId: randomUUID(),
    sourceBindingHash: intent.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
  // Original SQL authority is a contract double, not a persisted/physical claim.
  const lifecycle = { status: vi.fn(async () => ({ intent, record })) }
  const owners = { resolve: vi.fn(async () => { throw new Error('No filesystem owner lookup in status fixture') }) }
  const transfers = { intent: vi.fn(async () => intent) }
  const extension = createMainSourceOperationExtension(owners, transfers, lifecycle)
  const context = { binding, signal: new AbortController().signal }
  return { binding, intent, record, lifecycle, owners, transfers, extension, context }
}

describe('original Main committed source-status carrier', () => {
  it('reads only the original lifecycle using the actual authenticated frame and preserves exact facts', async () => {
    const f = fixture()
    const reply = await f.extension.handle!({ version: 1, operation: 'sources.transfer-status', transferId: f.intent.transferId }, f.context)
    expect(f.lifecycle.status).toHaveBeenCalledWith(f.intent.transferId, f.binding)
    expect(reply.payload).toEqual({ version: 1, operation: 'sources.transfer-status', intent: f.intent, record: f.record })
    expect(f.owners.resolve).not.toHaveBeenCalled(); expect(f.transfers.intent).not.toHaveBeenCalled()
  })
  it('propagates denied authority and rejects peer bytes, missing providers and caller ACK flags', async () => {
    const f = fixture(), request = { version: 1, operation: 'sources.transfer-status', transferId: f.intent.transferId }
    f.lifecycle.status.mockRejectedValueOnce(new Error('Original caller denied'))
    await expect(f.extension.handle!(request, f.context)).rejects.toThrow('Original caller denied')
    await expect(f.extension.handle!(request, { ...f.context, bytes: Buffer.from('peer ACK') })).rejects.toThrow()
    expect(f.lifecycle.status).toHaveBeenCalledTimes(1)
    await expect(f.extension.handle!({ ...request, published: true }, f.context)).rejects.toThrow()
    const missing = createMainSourceOperationExtension(f.owners, f.transfers)
    await expect(missing.handle!(request, f.context)).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_STATUS_UNAVAILABLE' })
  })
})

it.each(['timeout', 'source-repository-timeout'])('maps %s from the exact repository request to a sanitized retryable domain error', async code => {
  const f = fixture(), request = vi.fn(async () => { throw new DeviceApplicationError(code) })
  const root: SourceRootRecord = { version: 1, binding: f.record.receipt.binding,
    source: { approvedSourceId: randomUUID(), snapshotId: f.record.receipt.binding.snapshotId, manifestDigest: f.record.receipt.verifiedManifestDigest },
    selection: { hostRef: { kind: 'device', mainId: f.binding.mainId, deviceId: f.binding.deviceId }, rootPolicyId: f.record.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
    registration: { workerInstallationId: f.binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(), attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString() }
  const { connectionEpoch: _epoch, ...identity } = f.binding
  void _epoch
  const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity, request }) },
    { prepareIdentity: async () => { throw new Error('No new owner') }, resolve: async () => ({ root }) as never },
    { send: async () => { throw new Error('No new transfer') } })
  await expect(host.privateRepository(f.record, {} as never)).rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_TIMEOUT', status: 503, details: { retryable: true } })
  expect(request).toHaveBeenCalledOnce()
})
