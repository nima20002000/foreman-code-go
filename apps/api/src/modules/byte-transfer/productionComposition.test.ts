import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { createProductionRsyncComposition, type ProductionRsyncProviders } from './productionComposition.js'
import { ResumableByteTransferService } from './service.js'
import { transferContextForBinding } from './carrier.js'

const roots: string[] = [], receivers: ResumableByteTransferService[] = []
afterEach(async () => {
  for (const receiver of receivers.splice(0)) await receiver.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(fileURLToPath(new URL('../../../../../../../../', import.meta.url)), '.graphql-rsync-composition-'))
  roots.push(root)
  const stagingRoot = join(root, 'rsync'); await mkdir(stagingRoot, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const sha256 = createHash('sha256').update('abcdefgh').digest('hex')
  const intent: TransferIntent = { ...transferContextForBinding(binding), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), rootId: randomUUID(), rootBindingRevision: 1, placementHash: sha256,
    direction: 'to-worker', byteClass: 'source', sha256, byteSize: 8, manifestDigest: sha256,
    chunkBytes: 4, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  let denied = false
  const accepted = { intent: async (id: string) => { if (id !== intent.transferId) throw new Error('Unknown original intent'); return intent },
    authorize: vi.fn(async () => { if (denied) throw new Error('Denied original accepted owner') }) }
  const receiver = new ResumableByteTransferService(join(root, 'canonical'), accepted); receivers.push(receiver)
  const providers: ProductionRsyncProviders = { stagingRoot, accepted, receiver,
    resolveSource: vi.fn(async () => ({ read: async () => { throw new Error('No output bytes supplied by this composition-only fixture') } })),
    acknowledged: vi.fn(async () => { throw new Error('No canonical acknowledgement in this fixture') }),
    quiescent: vi.fn(async () => { throw new Error('No stopped-writer proof in this fixture') }) }
  return { root, binding, intent, providers, receiver, deny: () => { denied = true }, current: () => binding }
}

describe('original rsync common composition, no SSH/native acceptance', () => {
  it('keeps discovery absent and selected send unavailable when original ports are missing', () => {
    const mounted = createProductionRsyncComposition({ side: 'main', current: () => undefined })
    expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
    expect(mounted.missing).toContain('canonical acknowledgement')
    if (mounted.kind !== 'unavailable') throw new Error('Missing original ports were advertised')
    expect(() => mounted.sender()).toThrow('Selected rsync is missing')
  })
  it('requires every worker provider before advertising metadata-only control', async () => {
    const f = await fixture()
    for (const field of ['stagingRoot', 'accepted', 'receiver', 'resolveSource', 'acknowledged', 'quiescent'] as const) {
      const providers: Partial<ProductionRsyncProviders> = { ...f.providers }; delete providers[field]
      const mounted = createProductionRsyncComposition({ side: 'worker', providers, current: f.current })
      expect(mounted.kind, field).toBe('unavailable'); expect(mounted.extensions, field).toEqual([])
    }
    const mounted = createProductionRsyncComposition({ side: 'worker', providers: f.providers, current: f.current })
    expect(mounted.kind).toBe('configured')
    expect(mounted.extensions[0]).toMatchObject({ ...RSYNC_STAGE_EXTENSION, role: 'server', handle: expect.any(Function) })
  })
  it('requires Main explicit selection and its existing captured W07 channel', async () => {
    const f = await fixture(), selection = vi.fn(async () => { throw new Error('No trusted physical selection in this fixture') })
    const partial = createProductionRsyncComposition({ side: 'main', providers: { ...f.providers, selection }, current: f.current })
    expect(partial.kind).toBe('unavailable'); expect(partial.missing).toEqual(['existing W07 rsync control channel'])
    const mounted = createProductionRsyncComposition({ side: 'main', providers: { ...f.providers, selection,
      peer: { capture: () => undefined } }, current: f.current })
    expect(mounted.kind).toBe('configured')
    expect(mounted.extensions).toEqual([{ ...RSYNC_STAGE_EXTENSION, role: 'client' }])
    expect(selection).not.toHaveBeenCalled()
    if (mounted.kind !== 'configured') throw new Error('Complete fixture ports were not composed')
    await expect(mounted.sender({ read: async () => Buffer.alloc(0) }).send(f.intent)).rejects.toThrow('No trusted physical selection')
    expect(f.providers.resolveSource).not.toHaveBeenCalled()
  })
  it('uses one genuine receiver journal for external and canonical bytes and denies stale/revoked callers', async () => {
    const f = await fixture(), mounted = createProductionRsyncComposition({ side: 'worker', providers: f.providers, current: f.current })
    if (mounted.kind !== 'configured') throw new Error('Complete fixture ports were not composed')
    const extension = mounted.extensions[0]!, signal = new AbortController().signal
    const command = { kind: 'rsync-stage-v1', method: 'receiver-prepare', transferId: f.intent.transferId }
    await expect(extension.handle!(command, { binding: { ...f.binding, connectionGeneration: 2 }, signal })).rejects.toThrow('Stale')
    await expect(readFile(join(f.root, 'canonical', `${f.intent.transferId}.json`))).rejects.toThrow()
    await extension.handle!(command, { binding: f.binding, signal })
    const journal = join(f.root, 'canonical', `${f.intent.transferId}.json`), before = await readFile(journal, 'utf8')
    expect(JSON.parse(before).payload).toMatchObject({ canonical: true,
      external: { 'rsync-receiver': { byteSize: f.intent.byteSize * 3, released: false } } })
    await extension.handle!({ ...command, method: 'receiver-interrupt' }, { binding: f.binding, signal })
    expect(await readFile(journal, 'utf8')).toBe(before)
    f.deny()
    await expect(extension.handle!(command, { binding: f.binding, signal })).rejects.toThrow('Denied')
    expect(await readFile(journal, 'utf8')).toBe(before)
  })
})
