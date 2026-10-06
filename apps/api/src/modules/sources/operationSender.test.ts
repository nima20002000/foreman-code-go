import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { TransferExpiredError } from '../byte-transfer/service.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { ExistingByteTransferSourcePackageSender, type SourcePackageTransferAdmission } from './operationSender.js'

it('replaces a source transfer the receiver idle-expired instead of resending it until preparation times out', async () => {
  const bytes = Buffer.from('original source bytes\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(), capturePolicy: 'exclusive-explicit-bytes-v1',
    executablePolicy: 'strip', entries: [{ path: 'file.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const root = { binding: { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), rootId: randomUUID(), bindingRevision: 1 },
    source: { manifestDigest: manifest.manifestDigest } } as unknown as SourceRootRecord
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1 }
  const identity = { operationId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() } as Parameters<SourcePackageTransferAdmission['allocate']>[0]['identity']
  const allocations: (string | undefined)[] = [], expired = new Set<string>()
  const admission: SourcePackageTransferAdmission = {
    revalidate: async () => {},
    allocate: async input => {
      allocations.push(input.replaces)
      return { mainId: root.binding.mainId, deviceId: root.binding.deviceId!, workerInstallationId: root.binding.workerInstallationId!, keyRevision: 1,
        authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), version: 1, transferId: randomUUID(), operationId: input.identity.operationId,
        executionId: attempt.executionId, attemptId: attempt.attemptId, placementHash: attempt.placementHash, rootId: root.binding.rootId,
        rootBindingRevision: 1, direction: 'to-worker', byteClass: 'source', sha256: input.sha256, byteSize: input.byteSize,
        manifestDigest: manifest.manifestDigest, expiresAt: identity.expiresAt, chunkBytes: 1024 * 1024 } satisfies TransferIntent
    },
    sender: () => ({ send: async (intent: TransferIntent) => {
      if (!allocations.at(-1)) { expired.add(intent.transferId); throw new TransferExpiredError('Transfer expired') }
      return { transferId: intent.transferId, receiptId: randomUUID(), sha256: intent.sha256, byteSize: intent.byteSize } as never
    } }),
  }
  const sender = new ExistingByteTransferSourcePackageSender({ read: async () => bytes }, admission)
  const result = await sender.send(manifest, root, attempt, identity)
  expect(allocations).toHaveLength(2)
  expect(expired.has(allocations[1]!)).toBe(true)
  expect(expired.has(result.transferId)).toBe(false)
})
