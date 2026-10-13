import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationReceiptSchema, type WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'

const ArchiveSchema = z.object({ receipt: WorkerConversationReceiptSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Closed receipts retain all replay identities outside the bounded recovery snapshot. */
export class WorkerConversationArchive {
  constructor(private readonly path: string, private readonly byteLimit: number,
    private readonly write: (path: string, value: string) => Promise<void>) {}

  private recordPath(conversationId: string) {
    return `${this.path}.conversations/${commandInputHash(conversationId)}.json`
  }

  async read(conversationId: string): Promise<WorkerConversationReceipt | undefined> {
    const path = this.recordPath(conversationId)
    let serialized: string
    try {
      if ((await stat(path)).size > this.byteLimit + 1024) throw new Error('Conversation archive byte limit reached')
      serialized = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const archive = ArchiveSchema.parse(JSON.parse(serialized))
    if (!archive.receipt.closed || archive.receipt.binding.owner.conversationId !== conversationId
      || commandInputHash(archive.receipt) !== archive.digest) {
      throw new Error('Conversation archive changed: recovery required')
    }
    return archive.receipt
  }

  async save(receipt: WorkerConversationReceipt) {
    const record = WorkerConversationReceiptSchema.parse(receipt)
    if (!record.closed) throw new Error('Positive conversation closure required')
    await this.write(this.recordPath(record.binding.owner.conversationId),
      JSON.stringify({ receipt: record, digest: commandInputHash(record) }))
  }
}
