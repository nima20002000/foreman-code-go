import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as fileSystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKER_UPDATE_MAX_BINARY_BYTES, WORKER_UPDATE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors,
  type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { createWorkerArtifactExtension } from './workerArtifacts.js'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'worker-artifacts-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o700)
  const content = Buffer.alloc(WORKER_UPDATE_MAX_BINARY_BYTES + 11, 7)
  for (let index = 0; index < content.length; index++) content[index] = index % 251
  const manifest = { format: 1, version: '0.0.57', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    sourceSnapshot: { commit: 'a'.repeat(40), files: [] },
    files: [{ path: 'src/cli.mjs', sha256: sha256(content), size: content.length }] }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = sha256(manifestBytes)
  const release = join(directory, manifestSha256)
  await mkdir(join(release, 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(release, 'src/cli.mjs'), content)
  await writeFile(join(release, 'manifest.json'), manifestBytes)
  await writeFile(join(directory, 'index.json'), JSON.stringify({ format: 1, version: manifest.version,
    artifacts: [{ target, manifestSha256 }] }))
  const extension = createWorkerArtifactExtension({ directory, version: manifest.version })
  const context = { binding: { mainId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: '33333333-3333-4333-8333-333333333333',
    bootId: '44444444-4444-4444-8444-444444444444', connectionEpoch: '55555555-5555-4555-8555-555555555555',
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, signal: new AbortController().signal }
  const request = (raw: unknown) => extension.handle!(raw, context)
  return { directory, content, manifest, manifestBytes, manifestSha256, release, extension, context, request }
}

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', text, false) })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

function channelPair(f: Awaited<ReturnType<typeof fixture>>, revalidate: () => Promise<void>) {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const client: DeviceExtensionRegistration = { ...f.extension, role: 'client' }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([f.extension]), extensionDescriptors([client]))
  const abort = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.context.binding, socket: mainSocket,
    signal: abort.signal, extensions, registrations: [f.extension], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.context.binding, socket: workerSocket,
    signal: abort.signal, extensions, registrations: [client] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 60_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 60_000)]
  cleanup.push(async () => {
    abort.abort()
    main.close()
    worker.close()
    await Promise.allSettled(tasks)
  })
  void Promise.allSettled(tasks)
  return worker
}

describe('Worker artifact serving', () => {
  it('serves matching release metadata and binary chunks over the authenticated device channel', async () => {
    const f = await fixture()
    const worker = channelPair(f, async () => {})
    const release = await worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'release', target })
    expect(release.payload).toEqual({ operation: 'release', release: {
      version: '0.0.57', manifestSha256: f.manifestSha256, manifest: f.manifest,
    } })
    const chunk = await worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'chunk', manifestSha256: f.manifestSha256,
      path: 'src/cli.mjs', offset: 0 })
    expect(chunk.bytes).toEqual(f.content.subarray(0, WORKER_UPDATE_MAX_BINARY_BYTES))
    expect(chunk.payload).toMatchObject({ byteSize: WORKER_UPDATE_MAX_BINARY_BYTES })
  })

  it('denies a device whose authenticated grant no longer validates before serving bytes', async () => {
    const f = await fixture()
    const handle = vi.fn(f.extension.handle!)
    f.extension.handle = handle
    const worker = channelPair(f, async () => { throw Object.assign(new Error('Device revoked'), { code: 'revoked' }) })
    await expect(worker.request(WORKER_UPDATE_NAMESPACE, { operation: 'release', target })).rejects.toThrow()
    expect(handle).not.toHaveBeenCalled()
  })

  it('returns no release for an unsupported runtime and refuses a different Main version', async () => {
    const f = await fixture()
    expect(await f.request({ operation: 'release', target: { ...target, node: 'v22.1.0' } }))
      .toEqual({ payload: { operation: 'release', release: null } })
    const wrong = createWorkerArtifactExtension({ directory: f.directory, version: '0.0.58' })
    await expect(wrong.handle!({ operation: 'release', target }, f.context)).rejects.toThrow()
  })

  it('serves raw manifest bytes and the final short and empty file chunks', async () => {
    const f = await fixture()
    const request = { operation: 'chunk', manifestSha256: f.manifestSha256, path: 'src/cli.mjs', offset: 0 }
    expect((await f.request({ ...request, path: 'manifest.json' })).bytes).toEqual(f.manifestBytes)
    expect((await f.request({ ...request, offset: WORKER_UPDATE_MAX_BINARY_BYTES })).bytes)
      .toEqual(f.content.subarray(WORKER_UPDATE_MAX_BINARY_BYTES))
    expect((await f.request({ ...request, offset: f.content.length })).bytes).toEqual(Buffer.alloc(0))
    await expect(f.request({ ...request, offset: f.content.length + 1 })).rejects.toThrow()
  })

  it('shares one bounded streaming verification across concurrent range downloads', async () => {
    const f = await fixture()
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const reads: Array<() => number[]> = []
    vi.mocked(fileSystem.open).mockImplementation(async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode)
      if (String(path) === join(f.release, 'src/cli.mjs')) {
        const read = vi.spyOn(handle, 'read')
        reads.push(() => read.mock.calls.map(args => Number([...args][2])))
      }
      return handle
    })
    try {
      const offsets = [0, 31, WORKER_UPDATE_MAX_BINARY_BYTES]
      const chunks = await Promise.all(offsets.map(offset => f.request({ operation: 'chunk',
        manifestSha256: f.manifestSha256, path: 'src/cli.mjs', offset })))
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.bytes).toEqual(f.content.subarray(offsets[index]!, offsets[index]! + WORKER_UPDATE_MAX_BINARY_BYTES))
      }
      const lengths = reads.flatMap(read => read())
      const servedBytes = chunks.reduce((total, chunk) => total + chunk.bytes!.byteLength, 0)
      expect(lengths.every(length => length <= WORKER_UPDATE_MAX_BINARY_BYTES)).toBe(true)
      expect(lengths.reduce((total, length) => total + length, 0)).toBe(f.content.byteLength + servedBytes)
    } finally {
      vi.mocked(fileSystem.open).mockImplementation(original.open)
    }
  })

  it('rejects unlisted files, traversal, unknown digests, and symlink escapes', async () => {
    const f = await fixture()
    const request = { operation: 'chunk', manifestSha256: f.manifestSha256, path: 'src/cli.mjs', offset: 0 }
    for (const change of [{ path: 'identity.json' }, { path: '../identity.json' }, { manifestSha256: 'c'.repeat(64) }]) {
      await expect(f.request({ ...request, ...change })).rejects.toThrow()
    }
    await rm(join(f.release, 'src'), { recursive: true })
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'cli.mjs'), f.content)
    await symlink(outside, join(f.release, 'src'))
    await expect(f.request(request)).rejects.toThrow()
  })

  it('rechecks file and manifest digests after release discovery', async () => {
    const f = await fixture()
    await f.request({ operation: 'release', target })
    const request = { operation: 'chunk', manifestSha256: f.manifestSha256, path: 'src/cli.mjs', offset: 0 }
    await f.request(request)
    await writeFile(join(f.release, 'src/cli.mjs'), Buffer.alloc(f.content.length, 8))
    await expect(f.request(request)).rejects.toThrow()
    const manifestBytes = await readFile(join(f.release, 'manifest.json'))
    await writeFile(join(f.release, 'manifest.json'), Buffer.concat([manifestBytes, Buffer.from(' ')]))
    await expect(f.request({ ...request, path: 'manifest.json' })).rejects.toThrow()
  })
})
