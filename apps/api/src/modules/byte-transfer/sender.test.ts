import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ByteTransferPort, TransferContext, TransferIntent, TransferProgress, VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferSender } from './sender.js'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
it('resumes the same immutable intent after lost chunk/final ACK and keeps reads bounded', async () => {
  const bytes = Buffer.from('abcdefgh'), contexts: TransferContext[] = []
  const context = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(),
    attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main',
    byteClass: 'source', sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(bytes), chunkBytes: 4,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const replacementEpoch = randomUUID()
  let offset = 0, lostChunk = true, lostFinal = true, starts = 0
  const progress = (): TransferProgress => ({ version: 1, transferId: intent.transferId, state: 'transferring',
    receivedInMemoryBytes: 0, durableOffset: offset, verifiedBytes: 0, updatedAt: new Date().toISOString() })
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: intent.transferId, intent,
    sha256: intent.sha256, byteSize: bytes.length, verifiedAt: new Date().toISOString() }
  const receiver: ByteTransferPort = {
    start: async same => { expect(same).toEqual(intent); starts++; return progress() }, status: async () => progress(),
    append: async (_, current, chunk) => {
      contexts.push(current); expect(chunk.offset).toBe(offset); expect(chunk.bytes.byteLength).toBeLessThanOrEqual(4)
      offset += chunk.bytes.byteLength
      if (lostChunk) { lostChunk = false; throw new Error('carrier-interrupted') }
      return progress()
    }, finish: async () => { if (lostFinal) { lostFinal = false; throw new Error('carrier-interrupted') }; return receipt },
    cancel: async () => progress(),
  }
  const sender = new ResumableByteTransferSender(receiver, { read: async (_, at, length) => bytes.subarray(at, at + length) },
    { current: async () => ({ ...context, connectionEpoch: contexts.length ? replacementEpoch : context.connectionEpoch }), retryable: error => (error as Error).message === 'carrier-interrupted' })
  expect(await sender.send(intent)).toEqual(receipt); expect(starts).toBe(1); expect(offset).toBe(8)
  expect(contexts.map(c => c.connectionEpoch)).toEqual([context.connectionEpoch, replacementEpoch])
})
