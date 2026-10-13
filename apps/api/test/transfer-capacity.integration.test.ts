import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BYTE_TRANSFER_POLICY, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferService } from '../src/modules/byte-transfer/service.js'

it('admits new transfers after retiring the record limit and preserves replay denials after restart', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'transfer-capacity-'))
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: 'execution', attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(),
    rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: createHash('sha256').digest('hex'), byteSize: 0, manifestDigest: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + BYTE_TRANSFER_POLICY.maxLifetimeMs - 1000).toISOString(), chunkBytes: 8192 }
  let admissionSyncs = 0
  const createService = () => new ResumableByteTransferService(root, { authorize: async () => {} }, undefined,
    async point => { if (point === 'directory-sync') admissionSyncs++ })
  let service = createService()
  try {
    for (let index = 0; index < BYTE_TRANSFER_POLICY.maxRecords; index++) {
      const current = { ...intent, transferId: index === 0 ? intent.transferId : randomUUID() }
      admissionSyncs = 0
      await service.start(current, context)
      expect(admissionSyncs).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal + 2)
      expect((await service.inventory()).length).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal)
      await service.finish(current.transferId, context)
      await service.retire(current.transferId)
    }
    await service.close()
    service = createService()
    const next = { ...intent, transferId: randomUUID() }
    expect((await service.start(next, context)).state).toBe('allocated')
    await expect(service.start(intent, context)).rejects.toThrow('cancelled')
    await expect(service.start({ ...intent, sha256: 'c'.repeat(64) }, context)).rejects.toThrow('immutable')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
