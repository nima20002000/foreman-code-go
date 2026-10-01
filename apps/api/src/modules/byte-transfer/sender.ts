import { createHash } from 'node:crypto'
import { BYTE_TRANSFER_POLICY, TransferProgressSchema, TransferIntentSchema, VerifiedTransferReceiptSchema,
  type ByteTransferPort, type TransferContext, type TransferIntent, type VerifiedTransferReceipt } from '@graphql/contracts/byte-transfer'

/** A/C supply only an already sealed immutable source/output snapshot, never a live work-file path. */
export interface ImmutableTransferSource {
  read(intent: TransferIntent, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}
export interface TransferSenderConnection {
  /** W07 owns reconnect/backoff. This resolves to the newly authenticated connection context. */
  current(signal?: AbortSignal): Promise<TransferContext>
  /** Only interrupted/lost-ACK carrier failures; never authorization, quota or integrity errors. */
  retryable(error: unknown): boolean
}
/** Sequential bounded sender over the sole W07 carrier, with receiver-authoritative recovery. */
export class ResumableByteTransferSender {
  constructor(private readonly receiver: ByteTransferPort, private readonly source: ImmutableTransferSource,
    private readonly connection: TransferSenderConnection) {}

  async send(input: TransferIntent, signal?: AbortSignal): Promise<VerifiedTransferReceipt> {
    const intent = TransferIntentSchema.parse(input)
    let retries = 0
    const check = () => { signal?.throwIfAborted(); if (Date.now() >= Date.parse(intent.expiresAt)) throw new Error('Transfer sender expired') }
    const retry = (error: unknown) => {
      check()
      if (!this.connection.retryable(error) || retries++ >= BYTE_TRANSFER_POLICY.maxRetries) throw error
    }
    const recover = async () => {
      for (;;) {
        check()
        try {
          const progress = TransferProgressSchema.parse(await this.receiver.status(intent.transferId, await this.connection.current(signal)))
          if (progress.transferId !== intent.transferId || progress.durableOffset > intent.byteSize || progress.state === 'cancelled') throw new Error('Invalid receiver progress')
          return progress
        }
        catch (error) { retry(error) }
      }
    }
    for (;;) {
      check()
      try { await this.receiver.start(intent, await this.connection.current(signal)); break }
      catch (error) { retry(error) }
    }
    let progress = await recover()
    while (progress.durableOffset < intent.byteSize) {
      check()
      if (progress.state === 'cancelled' || progress.durableOffset < 0 || progress.durableOffset > intent.byteSize) throw new Error('Invalid receiver progress')
      const offset = progress.durableOffset, length = Math.min(intent.chunkBytes, intent.byteSize - offset)
      const inputBytes = await this.source.read(intent, offset, length, signal)
      if (inputBytes.byteLength !== length) throw new Error('Immutable source length changed')
      const bytes = Buffer.from(inputBytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      try {
        check()
        const ack = await this.receiver.append(intent.transferId, await this.connection.current(signal), { offset, sha256, bytes })
        if (ack.transferId !== intent.transferId || ack.durableOffset !== offset + length) throw new Error('Invalid receiver acknowledgment')
        progress = ack
      } catch (error) { retry(error); progress = await recover() }
    }
    for (;;) {
      check()
      try {
        const receipt = VerifiedTransferReceiptSchema.parse(await this.receiver.finish(intent.transferId, await this.connection.current(signal)))
        if (receipt.transferId !== intent.transferId || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize
          || JSON.stringify(receipt.intent) !== JSON.stringify(intent)) throw new Error('Verified receipt identity mismatch')
        return receipt
      } catch (error) { retry(error) }
    }
  }
}
