import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, appendFile, writeFile, readFile, symlink, mkdir, rename, link } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BYTE_TRANSFER_POLICY, type TransferContext, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { ResumableByteTransferService } from './service.js'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = [], services: ResumableByteTransferService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(bytes = Buffer.from('abcdefgh')) {
  const root = await mkdtemp(join(homedir(), '.graphql-transfer-test-')); roots.push(root)
  let epoch = 1, revoked = false, now = Date.now(), failure: string | undefined
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: 'boot', connectionEpoch: 1 }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(Buffer.from('placement')),
    rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(Buffer.from('manifest')),
    expiresAt: new Date(now + 60_000).toISOString(), chunkBytes: 4 }
  const create = () => {
    const service = new ResumableByteTransferService(root, { authorize: async (_, current) => {
      if (revoked || current.connectionEpoch !== epoch) throw new Error('Denied current authority')
    } }, () => now, async point => { if (failure === point) throw new Error('Injected disk failure') })
    services.push(service); return service
  }
  const service = create()
  const chunk = (offset: number, value = bytes.subarray(offset, offset + 4)) => ({ offset, bytes: value, sha256: hash(value) })
  return { root, context, intent, bytes, service, create, chunk,
    revoke: () => { revoked = true }, reconnect: () => { epoch++; return { ...context, connectionEpoch: epoch, bootId: 'new-boot' } },
    time: (ms: number) => { now += ms }, fail: (point?: string) => { failure = point } }
}
describe('bounded authenticated transfer staging', () => {
  it('resumes authoritative offset across reconnect/restart and returns one final receipt after lost ACK', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    expect((await f.service.append(f.intent.transferId, f.context, f.chunk(0))).durableOffset).toBe(4)
    await f.service.close(); const resumed = f.create(), current = f.reconnect()
    expect((await resumed.status(f.intent.transferId, current)).durableOffset).toBe(4)
    await expect(resumed.append(f.intent.transferId, f.context, f.chunk(4))).rejects.toThrow('Denied')
    await resumed.append(f.intent.transferId, current, f.chunk(4))
    const receipt = await resumed.finish(f.intent.transferId, current)
    expect(await resumed.finish(f.intent.transferId, current)).toEqual(receipt)
    expect(await resumed.resolveVerifiedReceipt(f.intent.transferId, current)).toEqual(receipt)
    const stream = await resumed.openVerified(receipt, current), chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(f.bytes)
    await expect(resumed.openVerified({ ...receipt, receiptId: randomUUID() }, current)).rejects.toThrow('Unrecognized')
  })
  it('truncates uncommitted tails after data write/journal fsync failure before ACK', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    f.fail('journal-sync')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Injected')
    f.fail(); expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(0)
    expect((await readFile(join(f.root, `${f.intent.transferId}.part`))).length).toBe(0)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await appendFile(join(f.root, `${f.intent.transferId}.part`), 'tail')
    expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(4)
    expect(await readFile(join(f.root, `${f.intent.transferId}.part`))).toEqual(f.bytes.subarray(0, 4))
  })
  it('rejects offsets, size/hash lies and conflicting retries without advancing', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(4))).rejects.toThrow('offset')
    await expect(f.service.append(f.intent.transferId, f.context, { ...f.chunk(0), sha256: '0'.repeat(64) })).rejects.toThrow('Invalid')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0, Buffer.alloc(5)))).rejects.toThrow('allocation')
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0, Buffer.from('oops')))).rejects.toThrow('Conflicting')
    await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('integrity')
    await expect(f.service.start({ ...f.intent, sha256: '0'.repeat(64) }, f.context)).rejects.toThrow('immutable')
    expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(4)
  })
  it('fails closed on corruption, missing bytes and whole-object hash mismatch', async () => {
    const f = await fixture(); await f.service.start({ ...f.intent, sha256: '0'.repeat(64) }, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0)); await f.service.append(f.intent.transferId, f.context, f.chunk(4))
    await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('integrity')
    await writeFile(join(f.root, `${f.intent.transferId}.part`), 'corrupt!', { mode: 0o600 })
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow('corrupt')
    await rm(join(f.root, `${f.intent.transferId}.part`))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow()
  })
  it('reauthorizes revocation/expiry and never reports verified on fsync failure', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context); f.fail('data-sync')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Injected')
    f.fail(); expect((await f.service.status(f.intent.transferId, f.context)).verifiedBytes).toBe(0)
    f.revoke(); await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Denied')
    const g = await fixture(); await g.service.start(g.intent, g.context); g.time(60_001)
    await expect(g.service.finish(g.intent.transferId, g.context)).rejects.toThrow('expired')
    const record = JSON.parse(await readFile(join(g.root, `${g.intent.transferId}.json`), 'utf8'))
    expect(record.payload.progress.state).toBe('cancelled')
  })
  it('accepts zero bytes, tombstones cancellation and rejects other principals', async () => {
    const f = await fixture(Buffer.alloc(0)); await f.service.start(f.intent, f.context)
    await expect(f.service.status(f.intent.transferId, { ...f.context, deviceId: randomUUID() })).rejects.toThrow('principal')
    const receipt = await f.service.finish(f.intent.transferId, f.context); expect(receipt.byteSize).toBe(0)
    await f.service.cancel(f.intent.transferId, f.context)
    await expect(f.service.resolveVerifiedReceipt(f.intent.transferId, f.context)).rejects.toThrow('cancelled')
  })
  it('reserves persisted per-device quota and bounded chunk budget', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)
    await expect(f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)).rejects.toThrow('quota')
    await expect(f.service.start({ ...f.intent, chunkBytes: BYTE_TRANSFER_POLICY.maxChunkBytes + 1 }, f.context)).rejects.toThrow()
  })
  it('reconciles a lost final ACK after directory fsync failure without another receipt', async () => {
    const f = await fixture(Buffer.alloc(0)); await f.service.start(f.intent, f.context)
    f.fail('directory-sync'); await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('Injected')
    f.fail(); const receipt = await f.service.finish(f.intent.transferId, f.context)
    expect(await f.service.finish(f.intent.transferId, f.context)).toEqual(receipt)
  })
  it('anchors disk writes through ancestor swaps and rejects multiply linked bytes', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    const moved = f.root + '-moved'; roots.push(moved)
    await rename(f.root, moved)
    const outside = await mkdtemp(join(homedir(), '.graphql-outside-test-')); roots.push(outside)
    await symlink(outside, f.root)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    expect(await readFile(join(moved, `${f.intent.transferId}.part`))).toEqual(f.bytes.subarray(0, 4))
    await expect(readFile(join(outside, `${f.intent.transferId}.part`))).rejects.toThrow()
    await link(join(moved, `${f.intent.transferId}.part`), join(moved, 'another-link'))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow('Unsafe')
  })
  it('bounds cleanup and preserves cancellation tombstones after expiry', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context); f.time(60_001)
    expect(await f.service.cleanupExpired(1)).toBe(1)
    expect(await f.service.cleanupExpired(1)).toBe(0)
    await expect(readFile(join(f.root, `${f.intent.transferId}.part`))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).payload.progress.state).toBe('cancelled')
  })
  it('rejects symlink ancestors and hardlinked/symlink partial files', async () => {
    const f = await fixture(); const parent = join(f.root, 'real'); await mkdir(parent, { mode: 0o700 }); await symlink(parent, join(f.root, 'alias'))
    const service = new ResumableByteTransferService(join(f.root, 'alias', 'child'), { authorize: async () => {} }); services.push(service)
    await expect(service.start(f.intent, f.context)).rejects.toThrow('ancestor')
    await f.service.start(f.intent, f.context); await rm(join(f.root, `${f.intent.transferId}.part`))
    await symlink('/etc/passwd', join(f.root, `${f.intent.transferId}.part`))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow()
  })
})
