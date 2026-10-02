import { describe, it, expect, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { TransferIntent } from '@graphql/contracts/byte-transfer'
import { NodeRsyncExecutor, RsyncStagingTransport, rsyncCommand, validateRsyncEndpoint, verifyRsyncBinaries,
  type RsyncEndpoint, type RsyncExecutor, type RsyncStagingPorts } from './rsync.js'
import { RsyncPrivateStore } from './rsyncStore.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = Buffer.from('immutable app output\n')
const intent = (): TransferIntent => ({ version: 1, transferId: randomUUID(), operationId: randomUUID(),
  mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
  authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), executionId: randomUUID(),
  attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1,
  direction: 'to-worker', byteClass: 'artifact', sha256: digest(bytes), byteSize: bytes.length,
  manifestDigest: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), chunkBytes: 1024 })
const endpoint: RsyncEndpoint = { user: 'dexter', host: '100.76.219.118', localBinary: '/usr/bin/rsync',
  remoteBinary: '/usr/bin/rsync', localRoot: '/tmp/graphql-rsync-local', remoteRoot: '/tmp/graphql-rsync-remote',
  localBinarySha256: 'a'.repeat(64), remoteBinarySha256: 'b'.repeat(64) }
const context = (i: TransferIntent) => ({ mainId: i.mainId, deviceId: i.deviceId, workerInstallationId: i.workerInstallationId,
  keyRevision: i.keyRevision, authorizationRevision: i.authorizationRevision, bootId: i.bootId, connectionEpoch: i.connectionEpoch })
const signal = () => new AbortController().signal
async function fixture() {
  const root = await mkdtemp('/tmp/graphql-rsync-'), input = join(root, 'source')
  await writeFile(input, bytes, { mode: 0o600 })
  const source = await open(input, 'r'), release = vi.fn(async () => {})
  const store = new RsyncPrivateStore(join(root, 'private'), { reserve: vi.fn(async () => release), retire: async () => {} })
  return { root, input, source, release, store, dispose: async () => { await source.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('rsync argument and security boundary', () => {
  it.each(['$(touch /tmp/bad)', 'dexter;id', 'bad\nname', '-bad', 'user@host'])('rejects endpoint injection %s', value => {
    expect(() => validateRsyncEndpoint({ ...endpoint, host: value })).toThrow()
  })
  it.each(['/tmp/../escape', '/tmp/a b', '/tmp/$(id)', '/tmp/a\nb', '/tmp/a;id'])('rejects path injection %s', value => {
    expect(() => validateRsyncEndpoint({ ...endpoint, remoteRoot: value })).toThrow()
  })
  it.each(['to-main', 'to-worker'] as const)('only copies the exact UUID object %s', direction => {
    const i = { ...intent(), direction }, command = rsyncCommand(endpoint, i)
    expect(command.args.slice(-2)).toEqual(direction === 'to-worker'
      ? [`${endpoint.localRoot}/${i.transferId}.snapshot`, `dexter@100.76.219.118:${endpoint.remoteRoot}/${i.transferId}.part`]
      : [`dexter@100.76.219.118:${endpoint.remoteRoot}/${i.transferId}.snapshot`, `${endpoint.localRoot}/${i.transferId}.part`])
    expect(command.args).toContain('--protect-args')
    expect(command.args).not.toContain('--inplace'); expect(command.args).not.toContain('--delete')
    expect(command.args.join(' ')).toContain('StrictHostKeyChecking=yes')
    expect(command.args.join(' ')).toContain('ForwardAgent=no')
  })
  it('fails closed on existing vulnerable versions before any staging', async () => {
    const i = intent(), ports: RsyncStagingPorts = { source: vi.fn(), receiver: vi.fn() }
    const executor: RsyncExecutor = { run: vi.fn(async () => 'rsync  version 3.4.1  protocol version 32\n') }
    const transport = new RsyncStagingTransport(endpoint, { authorize: async () => {} }, ports, executor)
    await expect(transport.stage(i, async () => context(i))).rejects.toThrow('security qualification')
    expect(ports.source).not.toHaveBeenCalled(); expect(ports.receiver).not.toHaveBeenCalled()
  })
  it('checks installed binary hashes even with a current version', async () => {
    const executor = { run: async () => 'rsync  version 3.5.1  protocol version 32\n' }
    await expect(verifyRsyncBinaries(endpoint, executor, signal())).rejects.toThrow('binary changed')
  })
  it('denies revoked authority before any subprocess', async () => {
    const i = intent(), executor = { run: vi.fn() }
    const transport = new RsyncStagingTransport(endpoint, { authorize: async () => { throw new Error('revoked') } }, { source: vi.fn(), receiver: vi.fn() }, executor)
    await expect(transport.stage(i, async () => context(i))).rejects.toThrow('revoked')
    expect(executor.run).not.toHaveBeenCalled()
  })
  it('denies a changed principal', async () => {
    const i = intent(), transport = new RsyncStagingTransport(endpoint, { authorize: vi.fn() }, { source: vi.fn(), receiver: vi.fn() })
    await expect(transport.stage(i, async () => ({ ...context(i), authorizationRevision: 2 }))).rejects.toThrow('principal changed')
  })
  it('rejects expired intent and pre-cancellation', async () => {
    const i = intent(), transport = new RsyncStagingTransport(endpoint, { authorize: vi.fn() }, { source: vi.fn(), receiver: vi.fn() })
    await expect(transport.stage({ ...i, expiresAt: new Date(Date.now() - 1000).toISOString() }, async () => context(i))).rejects.toThrow('expiry')
    const abort = new AbortController(); abort.abort(new Error('stop'))
    await expect(transport.stage(i, async () => context(i), abort.signal)).rejects.toThrow('stop')
  })
  it('terminates only its owned subprocess on cancellation', async () => {
    const abort = new AbortController(), start = Date.now()
    const result = new NodeRsyncExecutor().run({ executable: '/usr/bin/sleep', args: ['30'] }, abort.signal)
    setTimeout(() => abort.abort(new Error('stop')), 30)
    await expect(result).rejects.toThrow('stop'); expect(Date.now() - start).toBeLessThan(2000)
  })
})
describe('private frozen bytes and receiver', () => {
  it('freezes bytes, preserves them after original mutation, and rejects changed identity', async () => {
    const f = await fixture(), i = intent()
    try {
      const snapshot = await f.store.freeze(i, f.source, signal())
      await writeFile(f.input, Buffer.alloc(bytes.length, 7))
      await snapshot.verify(signal()); await snapshot.close()
      expect(await readFile(join(f.store.root, `${i.transferId}.snapshot`))).toEqual(bytes)
      await expect(f.store.freeze({ ...i, attemptId: randomUUID() }, f.source, signal())).rejects.toThrow('identity conflicts')
      await f.store.retire(i)
    } finally { await f.dispose() }
  })
  it('rejects symlink staging roots', async () => {
    const f = await fixture()
    try {
      await symlink(f.root, join(f.root, 'linked'))
      const store = new RsyncPrivateStore(join(f.root, 'linked'), { reserve: async () => async () => {}, retire: async () => {} })
      await expect(store.receive(intent(), signal())).rejects.toThrow('ancestor')
    } finally { await f.dispose() }
  })
  it('retains interrupted partials and verifies resumed exact bytes before read', async () => {
    const f = await fixture(), i = intent(), path = join(f.store.root, `${i.transferId}.part`)
    try {
      const first = await f.store.receive(i, signal())
      await writeFile(path, bytes.subarray(0, 5), { mode: 0o600 }); await first.interrupt()
      expect(f.release).not.toHaveBeenCalled()
      const second = await f.store.receive(i, signal())
      await expect(second.verify(signal())).rejects.toThrow('length mismatch')
      await writeFile(path, bytes, { mode: 0o600 })
      const staged = await second.verify(signal())
      expect(await staged.read(0, bytes.length, signal())).toEqual(bytes)
      expect(staged.intent).toEqual(i); expect(staged).not.toHaveProperty('receiptId')
      await staged.close(); expect(f.release).toHaveBeenCalledOnce()
    } finally { await f.dispose() }
  })
  it('rejects competing writers, mutated pins and wrong hashes', async () => {
    const f = await fixture(), i = intent()
    try {
      const lease = await f.store.receive(i, signal())
      await expect(f.store.receive(i, signal())).rejects.toThrow()
      await writeFile(join(f.store.root, `${i.transferId}.part`), Buffer.alloc(bytes.length), { mode: 0o600 })
      await expect(lease.verify(signal())).rejects.toThrow('SHA-256')
      await lease.interrupt()
      await expect(f.store.receive({ ...i, executionId: randomUUID() }, signal())).rejects.toThrow('identity conflicts')
    } finally { await f.dispose() }
  })
  it('rejects part symlinks and quota failures', async () => {
    const f = await fixture(), i = intent()
    try {
      const lease = await f.store.receive(i, signal()); await lease.interrupt()
      const path = join(f.store.root, `${i.transferId}.part`)
      await rm(path); await symlink(f.input, path)
      await expect(f.store.receive(i, signal())).rejects.toThrow()
      const denied = new RsyncPrivateStore(join(f.root, 'denied'), { reserve: async () => { throw new Error('quota') }, retire: async () => {} })
      await expect(denied.receive(intent(), signal())).rejects.toThrow('quota')
    } finally { await f.dispose() }
  })
})
describe('rsync transport composition', () => {
  async function transferFixture() {
    const f = await fixture(), i = { ...intent(), direction: 'to-main' as const }
    const config = { ...endpoint, localBinary: f.input, localBinarySha256: digest(bytes), localRoot: f.store.root }
    const snapshot = { verify: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const ports: RsyncStagingPorts = { source: vi.fn(async () => snapshot), receiver: async value => f.store.receive(value, signal()) }
    const commandRun = vi.fn(async () => {
      await writeFile(join(f.store.root, `${i.transferId}.part`), bytes, { mode: 0o600 }); return ''
    })
    const executor: RsyncExecutor = { run: async (command, bounded) => {
      bounded.throwIfAborted()
      if (command.args[0] === '--version') return 'rsync  version 3.5.1  protocol version 32\n'
      if (command.executable === '/usr/bin/ssh') return `rsync  version 3.5.1  protocol version 32\n${config.remoteBinarySha256}  ${config.remoteBinary}\n`
      return commandRun()
    } }
    return { ...f, i, config, snapshot, ports, executor, commandRun }
  }
  it('returns verified bytes and original intent, leaving app publication separate', async () => {
    const f = await transferFixture(), authority = { authorize: vi.fn(async (_intent: TransferIntent, _context: ReturnType<typeof context>, _operation: string) => { void _intent; void _context; void _operation }) }
    try {
      const transport = new RsyncStagingTransport(f.config, authority, f.ports, f.executor)
      const staged = await transport.stage(f.i, async () => context(f.i))
      expect(authority.authorize.mock.calls.some(call => call[2] === 'start')).toBe(true)
      expect(authority.authorize.mock.calls.some(call => call[2] === 'finish')).toBe(true)
      expect(staged.intent).toEqual(f.i); expect(await staged.read(0, bytes.length, signal())).toEqual(bytes)
      expect(staged).not.toHaveProperty('receiptId'); expect(f.snapshot.close).toHaveBeenCalledOnce()
      await staged.close()
    } finally { await f.dispose() }
  })
  it('does not accept successful rsync exit with corrupt bytes', async () => {
    const f = await transferFixture()
    f.commandRun.mockImplementation(async () => { await writeFile(join(f.store.root, `${f.i.transferId}.part`), Buffer.alloc(bytes.length)); return '' })
    try {
      const transport = new RsyncStagingTransport(f.config, { authorize: async () => {} }, f.ports, f.executor)
      await expect(transport.stage(f.i, async () => context(f.i))).rejects.toThrow('SHA-256')
      expect(f.snapshot.close).toHaveBeenCalledOnce()
      const retry = await f.store.receive(f.i, signal()); await retry.interrupt()
    } finally { await f.dispose() }
  })
  it('rejects source mutation after transfer and releases writer lock', async () => {
    const f = await transferFixture()
    f.snapshot.verify.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('source changed') })
    try {
      const transport = new RsyncStagingTransport(f.config, { authorize: async () => {} }, f.ports, f.executor)
      await expect(transport.stage(f.i, async () => context(f.i))).rejects.toThrow('source changed')
      const retry = await f.store.receive(f.i, signal()); await retry.interrupt()
    } finally { await f.dispose() }
  })
  it('reauthorizes staged reads and refuses a new key revision', async () => {
    const f = await transferFixture(); let changed = false
    try {
      const transport = new RsyncStagingTransport(f.config, { authorize: async () => {} }, f.ports, f.executor)
      const staged = await transport.stage(f.i, async () => ({ ...context(f.i), keyRevision: changed ? 2 : 1 }))
      changed = true
      await expect(staged.read(0, bytes.length, signal())).rejects.toThrow('principal changed')
      await staged.close()
    } finally { await f.dispose() }
  })
})
describe('destination-local adoption', () => {
  it('uses the existing verified receipt and preserves staging until canonical acknowledgment', async () => {
    const { importRsyncStagedBytes } = await import('./rsyncAdapter.js')
    const { ResumableByteTransferService } = await import('./service.js')
    const f = await fixture(), i = intent()
    try {
      const stagedLease = await f.store.receive(i, signal())
      await writeFile(join(f.store.root, `${i.transferId}.part`), bytes, { mode: 0o600 })
      const staged = await stagedLease.verify(signal())
      const receiver = new ResumableByteTransferService(join(f.root, 'verified'), { authorize: async () => {} })
      const receipt = await importRsyncStagedBytes(staged, receiver, async () => context(i))
      expect(receipt.intent).toEqual(i); expect(receipt.sha256).toBe(i.sha256); expect(receipt.byteSize).toBe(bytes.length)
      expect(await readFile(join(f.store.root, `${i.transferId}.part`))).toEqual(bytes)
      await staged.close(); await receiver.cancel(i.transferId, context(i))
    } finally { await f.dispose() }
  })
})
