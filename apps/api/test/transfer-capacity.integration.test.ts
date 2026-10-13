import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  let service = new ResumableByteTransferService(root, { authorize: async () => {} })
  try {
    await service.start(intent, context)
    await service.finish(intent.transferId, context)
    await service.retire(intent.transferId)
    const original = JSON.parse(await readFile(join(root, `${intent.transferId}.json`), 'utf8')) as {
      payload: { intent: TransferIntent; progress: { transferId: string } }
    }
    // Seed the retained history from a real retired journal; exercise archival at its live batch boundary.
    for (let first = 1; first < BYTE_TRANSFER_POLICY.maxRecords; first += 32) {
      const count = Math.min(32, BYTE_TRANSFER_POLICY.maxRecords - first)
      await Promise.all(Array.from({ length: count }, async (_, offset) => {
        const index = first + offset
        const transferId = randomUUID()
        const payload = { ...original.payload, intent: { ...original.payload.intent, transferId },
          progress: { ...original.payload.progress, transferId } }
        const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
        const directory = index < 64 ? root : join(root, 'retired')
        await writeFile(join(directory, `${transferId}.json`), JSON.stringify({ checksum, payload }), { mode: 0o600 })
      }))
    }
    const beforeRestart = { ...intent, transferId: randomUUID() }
    expect((await service.start(beforeRestart, context)).state).toBe('allocated')
    await service.finish(beforeRestart.transferId, context)
    await service.retire(beforeRestart.transferId)
    await service.close()
    service = new ResumableByteTransferService(root, { authorize: async () => {} })
    const next = { ...intent, transferId: randomUUID() }
    expect((await service.start(next, context)).state).toBe('allocated')
    await expect(service.start(intent, context)).rejects.toThrow('cancelled')
    await expect(service.start({ ...intent, sha256: 'c'.repeat(64) }, context)).rejects.toThrow('immutable')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
