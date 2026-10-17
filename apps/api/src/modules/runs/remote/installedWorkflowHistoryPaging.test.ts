import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DeviceHistoryPageSchema } from '@foreman-code/contracts/device-application'
import { RemoteOperationStatusSchema } from '@foreman-code/contracts/remote-execution'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { readRemoteReceiptResponse } from './installedWorkflowResponsePages.js'
import { readJsonContinuation } from './jsonContinuation.js'
import { decodeResultCopies } from './executionResultCodec.js'
import { pageNativeHistory, readNativeHistoryMetadata } from './nativeHistoryPage.js'
import { readPhysicalReadout, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'

it.each(['receipt bytes', 'physical hashing'] as const)(
  'reuses the first installed history observation for metadata pages: %s', async measure => {
    const f = await runningInstalledFixture()
    const result = { outcome: 'succeeded' as const, output: { text: 'original answer '.repeat(80_000) } }
    try {
      f.finish('succeeded', result.output)
      await f.settled
      const first = await f.call('history', { afterSequence: -1, correlationId: 'execution:execution' })
      const raw = await readRemoteReceiptResponse(first.payload, f.intent, async request =>
        (await f.call('receipt-continuation', request)).payload) as { page: unknown; status: unknown }
      const page = DeviceHistoryPageSchema.parse(raw.page)
      const status = RemoteOperationStatusSchema.parse(raw.status)
      if (!page.metadata || status.status !== 'known') throw new Error('Expected paged terminal history')
      const originalReceipt = structuredClone(status.receipt)
      const prototype = Object.getPrototypeOf(createHash('sha256')) as { update: ReturnType<typeof createHash>['update'] }
      const update = vi.spyOn(prototype, 'update')
      let transferred = 0
      let pages = 0
      let hashed = 0
      let fields: unknown
      try {
        fields = await readJsonContinuation(page.metadata, async metadata => {
          const reply = await f.call('history', { metadata, receiptSequence: originalReceipt.sequence,
            afterSequence: page.nextAfterSequence, correlationId: 'execution:execution' })
          expect(reply.payload).not.toHaveProperty('status')
          expect(reply.payload).toMatchObject({ receiptIdentity: {
            intent: originalReceipt.intent, connection: originalReceipt.connection,
            workerIncarnationId: originalReceipt.workerIncarnationId, sequence: originalReceipt.sequence,
          } })
          transferred += Buffer.byteLength(JSON.stringify(reply.payload))
          pages++
          // The history metadata bytes belong to the first receipt even if the journal advances.
          const value = reply.payload as { page: unknown }
          const next = DeviceHistoryPageSchema.parse(value.page)
          if (!next.metadata) throw new Error('Missing history metadata continuation')
          return next.metadata
        })
        hashed = update.mock.calls.reduce((bytes, [data]) => bytes + Buffer.byteLength(data), 0)
      } finally {
        update.mockRestore()
      }
      expect(decodeResultCopies(fields)).toMatchObject({ terminalTurn: { result } })
      expect(pages).toBeGreaterThan(10)
      if (measure === 'receipt bytes') expect(transferred).toBeLessThan(page.metadata.byteSize * 2)
      else expect(hashed).toBeLessThan(page.metadata.byteSize * 2)
      expect(status.receipt).toEqual(originalReceipt)
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
    } finally {
      await f.host.close()
    }
  })

it('builds status physical evidence without reserving an unread metadata download', async () => {
  const f = await runningInstalledFixture()
  const result = { outcome: 'succeeded' as const, output: { text: 'status-result' + 'x'.repeat(3 * 1024 * 1024) } }
  try {
    f.finish('succeeded', result.output)
    await f.settled
    const downloads = Array.from({ length: 5 }, (_, index) => pageNativeHistory({
      events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded',
        output: { text: `reader-${index}` + 'x'.repeat(3 * 1024 * 1024) } },
    }).page.metadata!)
    for (let index = 0; index < 2; index++) {
      const reply = await f.call('status')
      const status = RemoteOperationStatusSchema.parse(await readRemoteReceiptResponse(reply.payload, f.intent,
        async request => (await f.call('receipt-continuation', request)).payload))
      expect(status.status).toBe('known')
      if (status.status !== 'known') throw new Error('Expected completed status')
      expect(status.receipt.terminal?.result).toEqual(result)
      const selector = { receiptSequence: status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }) }
      const readout = await readPhysicalReadout((await f.call('physical-readout', selector)).payload,
        async metadata => (await f.call('physical-readout', { ...selector, metadata })).payload)
      expect(readout.history?.terminalTurn?.result).toEqual(result)
    }
    for (const first of downloads) {
      const fields = await readJsonContinuation(first, async request => readNativeHistoryMetadata(request))
      expect(decodeResultCopies(fields)).toHaveProperty('terminalResult')
    }
    const history = await f.call('history', { afterSequence: -1, correlationId: 'execution:execution' })
    const raw = await readRemoteReceiptResponse(history.payload, f.intent,
      async request => (await f.call('receipt-continuation', request)).payload) as { page: unknown }
    const page = DeviceHistoryPageSchema.parse(raw.page)
    expect(page.metadata).toBeDefined()
    const fields = await readJsonContinuation(page.metadata!, async request => readNativeHistoryMetadata(request))
    expect(decodeResultCopies(fields)).toMatchObject({ terminalTurn: { result } })
  } finally {
    await f.host.close()
  }
})
