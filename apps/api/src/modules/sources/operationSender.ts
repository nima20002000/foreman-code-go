import { createHash } from 'node:crypto'
import type { SourceManifest } from '@graphql/contracts/source-materialization'
import { TransferIntentSchema, type TransferIntent } from '@graphql/contracts/byte-transfer'
import type { SourcePreparationIdentitySchema } from '@graphql/contracts/source-operations'
import type { z } from 'zod'
import type { SourceRootRecord } from '@graphql/contracts/source-admission'
import type { SourceByteReader, MaterializationAttempt } from './ports.js'
import type { AcceptedSourcePackageSender } from './operationCarrier.js'
import { sourcePackageHeader, sourcePackageStream } from './operationPackage.js'
import { SourceError, verifySourceBytes } from './manifest.js'
import type { ImmutableTransferSource, ResumableByteTransferSender } from '../byte-transfer/sender.js'

export interface SourcePackageTransferAdmission {
  /** Actual persisted source intent/receiver/expiry uses the original Main
   * source reservation and actual authenticated connection; no new fake IDs. */
  allocate(input: { root: SourceRootRecord; attempt: MaterializationAttempt; identity: z.infer<typeof SourcePreparationIdentitySchema>; sha256: string; byteSize: number }): Promise<TransferIntent>
  sender(source: ImmutableTransferSource, root: SourceRootRecord): Pick<ResumableByteTransferSender, 'send'>
  revalidate(root: SourceRootRecord, attempt: MaterializationAttempt, identity: z.infer<typeof SourcePreparationIdentitySchema>): Promise<void>
}
export class ExistingByteTransferSourcePackageSender implements AcceptedSourcePackageSender {
  constructor(private readonly bytes: SourceByteReader, private readonly admission: SourcePackageTransferAdmission) {}
  async send(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt, identity: z.infer<typeof SourcePreparationIdentitySchema>) {
    await this.admission.revalidate(root, attempt, identity)
    const signal = AbortSignal.timeout(Math.max(1, Math.min(Date.parse(identity.expiresAt) - Date.now(), 60 * 60 * 1000)))
    const header = sourcePackageHeader(manifest), hash = createHash('sha256'); let byteSize = 0
    for await (const value of sourcePackageStream(manifest, this.bytes, signal)) { const chunk = value as Buffer; hash.update(chunk); byteSize += chunk.byteLength }
    const sha256 = hash.digest('hex')
    await this.admission.revalidate(root, attempt, identity)
    const intent = TransferIntentSchema.parse(await this.admission.allocate({ root, attempt, identity, sha256, byteSize }))
    if (intent.operationId !== identity.operationId || intent.executionId !== attempt.executionId || intent.attemptId !== attempt.attemptId
      || intent.placementHash !== attempt.placementHash || intent.rootId !== root.binding.rootId || intent.rootBindingRevision !== root.binding.bindingRevision
      || intent.mainId !== root.binding.mainId || intent.deviceId !== root.binding.deviceId || intent.workerInstallationId !== root.binding.workerInstallationId
      || intent.keyRevision !== attempt.keyRevision || intent.authorizationRevision !== attempt.authorizationRevision || intent.byteClass !== 'source'
      || intent.direction !== 'to-worker' || intent.manifestDigest !== manifest.manifestDigest || intent.sha256 !== sha256 || intent.byteSize !== byteSize)
      throw new SourceError('SOURCE_TRANSFER_CONFLICT', 'The actual allocated transfer does not match this immutable original source operation.')
    let cachedPath: string | undefined, cachedBytes: Uint8Array | undefined
    const bytes = this.bytes, admission = this.admission
    const source: ImmutableTransferSource = { async read(_intent, offset, length, bounded) {
      const readSignal = bounded ? AbortSignal.any([signal, bounded]) : signal
      readSignal.throwIfAborted(); await admission.revalidate(root, attempt, identity)
      if (_intent.transferId !== intent.transferId || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 1 || length > intent.chunkBytes || offset + length > byteSize) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Invalid original package extent.')
      const output = Buffer.alloc(length); let copied = 0, position = offset
      if (position < header.length) { const count = Math.min(length, header.length - position); header.copy(output, 0, position, position + count); copied += count; position += count }
      let base = header.length
      for (const entry of manifest.entries) {
        if (copied === length) break
        if (position >= base + entry.byteSize) { base += entry.byteSize; continue }
        if (cachedPath !== entry.path) { cachedBytes = await bytes.read(manifest, entry, readSignal); verifySourceBytes(entry, cachedBytes); cachedPath = entry.path }
        const local = position - base, count = Math.min(length - copied, entry.byteSize - local)
        output.set(cachedBytes!.subarray(local, local + count), copied); copied += count; position += count; base += entry.byteSize
      }
      if (copied !== length) throw new SourceError('SOURCE_PACKAGE_INVALID', 'The immutable package extent changed.')
      return output
    } }
    const receipt = await this.admission.sender(source, root).send(intent, signal)
    await this.admission.revalidate(root, attempt, identity)
    return { transferId: receipt.transferId, receiptId: receipt.receiptId, sha256: receipt.sha256, byteSize: receipt.byteSize }
  }
}
