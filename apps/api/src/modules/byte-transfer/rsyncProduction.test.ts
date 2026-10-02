import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { TransferIntentSchema, type TransferIntent } from '@graphql/contracts/byte-transfer'
import type { TrustedConnectionCheck } from '@graphql/contracts/trusted-device-connection'
import { ResumableByteTransferService } from './service.js'
import { transferContextForBinding } from './carrier.js'
import { assertRsyncBackendSelection, createRsyncProductionBackend, type RsyncBackendSelection,
  type RsyncExternalStagingQuota, type RsyncControlRequest } from './rsyncProduction.js'
import type { RsyncExecutor } from './rsync.js'

const bytes = Buffer.from('exact accepted immutable package\n'), hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
async function fixture(direction: TransferIntent['direction'] = 'to-worker') {
  const root = await mkdtemp('/tmp/graphql-rsync-production-')
  const localRoot = join(root, 'main'), remoteRoot = join(root, 'worker')
  await mkdir(localRoot, { mode: 0o700 }); await mkdir(remoteRoot, { mode: 0o700 })
  const binary = join(root, 'binary'); await writeFile(binary, 'fixture binary', { mode: 0o600 })
  let bound: DeviceSessionBinding | undefined = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const original = bound
  const i = TransferIntentSchema.parse({ ...transferContextForBinding(bound), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(), rootBindingRevision: 1,
    direction, byteClass: direction === 'to-worker' ? 'source' : 'artifact', sha256: hash(bytes), byteSize: bytes.length,
    manifestDigest: hash(bytes), chunkBytes: 8, expiresAt: new Date(Date.now() + 120000).toISOString() })
  const registration = { mainId: original.mainId, deviceId: original.deviceId, workerInstallationId: original.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired' as const, scopes: ['connect' as const, 'heartbeat' as const] }
  const endpoint = { user: 'dexter', host: '100.76.219.118', localBinary: binary, remoteBinary: '/private/rsync', localRoot, remoteRoot,
    localBinarySha256: hash(Buffer.from('fixture binary')), remoteBinarySha256: 'b'.repeat(64) }
  const check: TrustedConnectionCheck = { registration, consent: { ...registration, revision: 1, endpoint: { transport: 'tailscale',
    host: endpoint.host, port: 22, osUser: endpoint.user }, hostKeyFingerprint: `SHA256:${'c'.repeat(43)}`, allowOwnerCommands: true,
    approvedBy: 'human-owner', approvalId: randomUUID(), approvedAt: new Date().toISOString(), privilege: 'selected-os-user',
    automaticSudo: false, grantsAgentPermissions: false }, state: 'ready', checkedAt: new Date().toISOString(),
    probe: { state: 'connected', hostKeyFingerprint: `SHA256:${'c'.repeat(43)}`, osUser: 'dexter', uid: 1000,
      hostname: 'worker', sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync 3.5.1', tailscaleVersion: '1.102.4' } }
  // Consent schema is strict: registration scopes/status are not owner-approval fields.
  delete (check.consent as unknown as Record<string, unknown>).scopes; delete (check.consent as unknown as Record<string, unknown>).status
  let denied = false, published = false, selection: RsyncBackendSelection = { backend: 'rsync', check, endpoint }
  const accepted = { intent: async (id: string) => { if (id !== i.transferId) throw new Error('unknown transfer'); return i },
    authorize: vi.fn(async (candidate: TransferIntent) => {
      if (denied) throw new Error('revoked original grant')
      if (!isDeepStrictEqual(candidate, i)) throw new Error('accepted pins changed')
    }) }
  const quota: RsyncExternalStagingQuota = { reserve: vi.fn(async () => {}), release: vi.fn(async () => {}) }
  const current = () => bound
  const mainReceiver = new ResumableByteTransferService(join(root, 'main-canonical'), accepted)
  const workerReceiver = new ResumableByteTransferService(join(root, 'worker-canonical'), accepted)
  const source = { read: vi.fn(async (_intent: TransferIntent, offset: number, length: number) => bytes.subarray(offset, offset + length)) }
  const acknowledge = vi.fn(async () => { if (!published) throw new Error('canonical not acknowledged') })
  const worker = createRsyncProductionBackend({ side: 'worker', stagingRoot: remoteRoot, accepted, current,
    receiver: workerReceiver, quota, resolveSource: async () => source, acknowledged: acknowledge })
  const commands: string[][] = []
  const executor: RsyncExecutor = { run: async (command, signal) => {
    signal.throwIfAborted(); commands.push(command.args)
    if (command.args[0] === '--version') return 'rsync  version 3.5.1  protocol version 33\n'
    if (command.executable === '/usr/bin/ssh') return `rsync  version 3.5.1  protocol version 33\n${endpoint.remoteBinarySha256}  ${endpoint.remoteBinary}\n`
    const [sourcePath, destinationPath] = command.args.slice(-2).map(path => path.replace('dexter@100.76.219.118:', ''))
    if (!sourcePath || !destinationPath) throw new Error('Missing fixture transfer paths')
    // Rsync completes by rename, including replacement of a verified read-only private part.
    const temporary = `${destinationPath}.fixture-temp`
    await copyFile(sourcePath, temporary); await rename(temporary, destinationPath); return ''
  } }
  const peer = { capture: () => bound ? { binding: bound, request: (request: RsyncControlRequest, options: { signal: AbortSignal }) => worker.handle(request,
    { binding: bound!, signal: options.signal }) } : undefined }
  const main = createRsyncProductionBackend({ side: 'main', stagingRoot: localRoot, current, accepted, quota,
    receiver: mainReceiver, acknowledged: acknowledge, selection: async () => selection, peer, executor })
  return { root, i, original, check, selection, main, worker, quota, source, commands, accepted, localRoot, remoteRoot, mainReceiver, workerReceiver,
    publish: () => { published = true }, deny: () => { denied = true }, disconnect: () => { bound = undefined },
    changeSelection: (next: RsyncBackendSelection) => { selection = next },
    dispose: async () => { await mainReceiver.close(); await workerReceiver.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('production rsync leaf', () => {
  it.each(['to-worker', 'to-main'] as const)('adopts original %s bytes into actual canonical verifier, retains staging before acknowledgment', async direction => {
    const f = await fixture(direction)
    try {
      const receipt = await f.main.send(f.i, direction === 'to-worker' ? f.source : undefined)
      expect(receipt.intent).toEqual(f.i); expect(receipt.sha256).toBe(hash(bytes))
      const receiver = direction === 'to-worker' ? f.workerReceiver : f.mainReceiver
      expect(await receiver.resolveVerifiedReceipt(f.i.transferId, transferContextForBinding(f.original))).toEqual(receipt)
      const path = join(direction === 'to-worker' ? f.remoteRoot : f.localRoot, `${f.i.transferId}.part`)
      expect(await readFile(path)).toEqual(bytes)
      await expect(f.main.acknowledge(f.i)).rejects.toThrow('canonical not acknowledged')
      expect(await readFile(path)).toEqual(bytes)
      const reserves = vi.mocked(f.quota.reserve).mock.calls
      expect(reserves.some(([, , input]) => input.kind === 'rsync-source' && input.byteSize === bytes.length * 2)).toBe(true)
      expect(reserves.some(([, , input]) => input.kind === 'rsync-receiver' && input.byteSize === bytes.length * 3)).toBe(true)
      f.publish(); await f.main.acknowledge(f.i)
      await expect(readFile(path)).rejects.toThrow()
      expect(vi.mocked(f.quota.release).mock.calls.some(([, kind]) => kind === 'rsync-source')).toBe(true)
      expect(vi.mocked(f.quota.release).mock.calls.some(([, kind]) => kind === 'rsync-receiver')).toBe(true)
    } finally { await f.dispose() }
  })
  it('never selects SSH from owner consent alone when original transfer grant is revoked', async () => {
    const f = await fixture()
    try { f.deny(); await expect(f.main.send(f.i, f.source)).rejects.toThrow('revoked'); expect(f.commands).toHaveLength(0) }
    finally { await f.dispose() }
  })
  it('keeps the verified producer copy after canonical adoption fails and retries the same intent', async () => {
    const f = await fixture()
    try {
      vi.spyOn(f.workerReceiver, 'append').mockRejectedValueOnce(new Error('canonical write interrupted'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('canonical write interrupted')
      const part = join(f.remoteRoot, `${f.i.transferId}.part`)
      expect(await readFile(part)).toEqual(bytes)
      expect(f.quota.release).not.toHaveBeenCalled()
      const receipt = await f.main.send(f.i, f.source)
      expect(receipt.intent).toEqual(f.i)
      expect(await f.workerReceiver.resolveVerifiedReceipt(f.i.transferId, transferContextForBinding(f.original))).toEqual(receipt)
      expect(await readFile(part)).toEqual(bytes)
      f.publish(); await f.main.acknowledge(f.i)
      await expect(readFile(part)).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('rejects missing shared quota before reading or writing source bytes', async () => {
    const f = await fixture()
    try {
      const backend = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, accepted: f.accepted,
        current: () => f.original, receiver: f.mainReceiver, selection: async () => f.selection })
      // Incoming authenticated source preparation does not require an SSH invocation.
      await expect(backend.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('immutable rsync source unavailable')
      const withSource = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, accepted: f.accepted,
        current: () => f.original, receiver: f.mainReceiver, resolveSource: async () => f.source })
      await expect(withSource.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('external staging quota unavailable')
      expect(f.source.read).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('rejects control paths, caller intent payloads, binary bytes and stale epochs', async () => {
    const f = await fixture()
    try {
      const request = { kind: 'rsync-stage-v1', method: 'receiver-prepare', transferId: f.i.transferId }
      const frame = { binding: f.original, signal: new AbortController().signal }
      await expect(f.worker.handle({ ...request, path: '/tmp/other' }, frame)).rejects.toThrow()
      await expect(f.worker.handle({ ...request, intent: f.i }, frame)).rejects.toThrow()
      await expect(f.worker.handle(request, { ...frame, bytes })).rejects.toThrow('byte payloads')
      await expect(f.worker.handle(request, { ...frame, binding: { ...f.original, connectionEpoch: randomUUID() } })).rejects.toThrow('Stale')
    } finally { await f.dispose() }
  })
  it('denies missing original source resolver rather than inferring native output paths', async () => {
    const f = await fixture('to-main')
    try {
      const worker = createRsyncProductionBackend({ side: 'worker', stagingRoot: f.remoteRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.workerReceiver, quota: f.quota })
      await expect(worker.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('immutable rsync source unavailable')
      expect(f.quota.reserve).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('denies worker-initiated SSH, arbitrary Main output and missing cleanup proof', async () => {
    const f = await fixture('to-main')
    try {
      await expect(f.worker.send(f.i)).rejects.toThrow('Main-selected')
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('cannot supply worker output')
      await expect(f.main.retireExpired({ ...f.i, expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow('Stopped rsync writer proof unavailable')
      expect(f.commands).toHaveLength(0)
    } finally { await f.dispose() }
  })
  it('rechecks original authority between bounded immutable source reads', async () => {
    const f = await fixture()
    try {
      f.source.read.mockImplementationOnce(async (_intent, offset, length) => { f.deny(); return bytes.subarray(offset, offset + length) })
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('revoked original grant')
      expect(f.source.read).toHaveBeenCalledOnce()
      expect(f.commands.some(args => args.includes('--partial'))).toBe(false)
    } finally { await f.dispose() }
  })
  it('fails when explicit selection or current connection is absent', async () => {
    const f = await fixture()
    try {
      f.disconnect(); await expect(f.main.send(f.i, f.source)).rejects.toThrow('connection is unavailable')
      const noSelection = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.mainReceiver, quota: f.quota })
      await expect(noSelection.send(f.i, f.source)).rejects.toThrow('Main-selected')
    } finally { await f.dispose() }
  })
})
describe('setup-bound selection', () => {
  it.each(['revoked', 'endpoint', 'host-key', 'expired', 'identity', 'port'] as const)('rejects %s before transport', async defect => {
    const f = await fixture()
    try {
      const s = structuredClone(f.selection)
      if (defect === 'revoked') s.check.consent!.allowOwnerCommands = false
      if (defect === 'endpoint') s.endpoint.host = 'other.example.com'
      if (defect === 'host-key') s.check.probe!.hostKeyFingerprint = `SHA256:${'d'.repeat(43)}`
      if (defect === 'expired') s.check.checkedAt = new Date(Date.now() - 61000).toISOString()
      if (defect === 'identity') s.check.registration.authorizationRevision++
      if (defect === 'port') s.check.consent!.endpoint.port = 2222
      expect(() => assertRsyncBackendSelection(s, f.i)).toThrow('selection')
    } finally { await f.dispose() }
  })
})
