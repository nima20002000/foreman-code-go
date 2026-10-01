import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TransferIntentSchema, BYTE_TRANSFER_POLICY } from './byteTransfer.js'
const intent = () => ({ version: 1, transferId: randomUUID(), mainId: randomUUID(), deviceId: randomUUID(),
  workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, bootId: 'boot', connectionEpoch: 1,
  operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(), placementHash: '0'.repeat(64),
  rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source', sha256: '0'.repeat(64),
  byteSize: 128 * 1024 * 1024, manifestDigest: '0'.repeat(64), expiresAt: new Date().toISOString(), chunkBytes: 1024 * 1024 })
describe('byte transfer v1 contract', () => {
  it('keeps source and artifact budgets distinct and forbids arbitrary paths', () => {
    expect(TransferIntentSchema.safeParse(intent()).success).toBe(true)
    expect(TransferIntentSchema.safeParse({ ...intent(), byteClass: 'artifact' }).success).toBe(false)
    expect(TransferIntentSchema.safeParse({ ...intent(), destinationPath: '/etc/passwd' }).success).toBe(false)
  })
  it('rejects unbounded negotiation and missing attempt bindings', () => {
    expect(TransferIntentSchema.safeParse({ ...intent(), chunkBytes: BYTE_TRANSFER_POLICY.maxChunkBytes + 1 }).success).toBe(false)
    expect(TransferIntentSchema.safeParse({ ...intent(), attemptId: undefined }).success).toBe(false)
  })
})
