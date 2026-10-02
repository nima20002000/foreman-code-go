import { randomUUID, createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerNativeOutputPublicationInput } from '@graphql/contracts/worker-native-output'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { WorkerNativeOutputRegistry, type WorkerNativeOutputPorts } from './workerNativeOutputRegistry.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Qualification/callback/current-grant/budget doubles ONLY. Files, anchored root,
// registry writes and frozen snapshots are real. This is not native qualification.
async function fixture() {
  // The scheduler's inherited TMPDIR has group-writable ancestors. Use a real
  // owned 0700 child of Linux sticky /tmp; never relax root qualification.
  const root = await mkdtemp('/tmp/worker-native-output-test-')
  const f = await fileToolFixture()
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const reservation = { assertCurrent: vi.fn(async () => {}), release: vi.fn(async () => {}) }
  const ports: WorkerNativeOutputPorts = {
    configuration: { harness: 'codex', model: 'unit-only', reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard' },
    scope: f.scope,
    callback: { assertCurrent: vi.fn(async () => {}) }, authority: { assertCurrent: vi.fn(async () => {}) },
    storage: { rootDirectory: root, assertProtected: vi.fn(async () => {}), reserve: vi.fn(async () => reservation) },
    publisher: { publish: vi.fn(async () => { throw new Error('No Main publisher in registry-only fixture') }) },
  }
  const registry = await WorkerNativeOutputRegistry.open(ports)
  // Tamper cases remove their extra entries before close; registry withdrawal
  // intentionally reports unexpected cleanup failures rather than hiding them.
  cleanups.push(() => registry.withdraw())
  const createCommand = { operation: 'create' as const, commandId: randomUUID(), filename: 'result.md', mediaType: 'text/markdown' as const }
  const create = async () => {
    const reply = await registry.dispatch(createCommand)
    if (reply.operation !== 'create') throw new Error('fixture')
    return reply.artifactId
  }
  const append = (artifactId: string, bytes = Buffer.from('# real output\n'), offset = 0, commandId: string = randomUUID()) =>
    registry.dispatch({ operation: 'append', commandId, artifactId, offset, contentBase64: bytes.toString('base64') })
  const seal = (artifactId: string, commandId: string = randomUUID()) => registry.dispatch({ operation: 'seal', artifactId, commandId })
  const publication = async (artifactId: string): Promise<WorkerNativeOutputPublicationInput> => ({ artifactId, commandId: randomUUID(),
    filename: 'result.md', mediaType: 'text/markdown' })
  return { root, scope: f.scope, ports, reservation, registry, createCommand, create, append, seal, publication }
}

describe('closed worker-native output registry', () => {
  it('creates actual private bytes with host-issued opaque handles and exact retries', async () => {
    const f = await fixture(), artifactId = await f.create()
    expect(await readdir(f.root)).toEqual([artifactId])
    expect(await f.create()).toBe(artifactId)
    const commandId = randomUUID(), bytes = Buffer.from('# original\n')
    const reply = await f.append(artifactId, bytes, 0, commandId)
    expect(await f.append(artifactId, bytes, 0, commandId)).toEqual(reply)
    expect(await readFile(join(f.root, artifactId))).toEqual(bytes)
    const sealId = randomUUID()
    expect(await f.seal(artifactId, sealId)).toEqual({ operation: 'seal', artifactId, byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(await f.seal(artifactId, sealId)).toEqual(await f.seal(artifactId))
    expect(f.ports.storage.reserve).toHaveBeenCalledTimes(1)
  })
  it.each(['read-only', 'danger-full-access'] as const)('denies saved %s even with permissive test ports', async sandbox => {
    const f = await fixture()
    await expect(WorkerNativeOutputRegistry.open({ ...f.ports, configuration: { ...f.ports.configuration, sandbox } })).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
  })
  it.each(['callback', 'authority', 'storage'] as const)('requires genuine %s admission and denies before file creation', async boundary => {
    const f = await fixture()
    if (boundary === 'storage') vi.mocked(f.ports.storage.assertProtected).mockRejectedValue(new Error('unqualified sandbox/root overlap'))
    else vi.mocked(f.ports[boundary].assertCurrent).mockRejectedValue(new Error('original source denied'))
    await expect(f.create()).rejects.toThrow()
    expect(await readdir(f.root)).toEqual([])
  })
  it('requires a real budget reservation and rejects expired reservations on cached replies', async () => {
    const f = await fixture()
    vi.mocked(f.ports.storage.reserve).mockRejectedValueOnce(new Error('aggregate budget exhausted'))
    await expect(f.create()).rejects.toThrow('budget exhausted')
    expect(await readdir(f.root)).toEqual([])
    await f.create()
    f.reservation.assertCurrent.mockRejectedValue(new Error('budget expired'))
    await expect(f.create()).rejects.toThrow('budget expired')
  })
  it('rejects changed commands, foreign handles and arbitrary path fields', async () => {
    const f = await fixture(), artifactId = await f.create(), commandId = randomUUID()
    await f.append(artifactId, Buffer.from('a'), 0, commandId)
    await expect(f.append(artifactId, Buffer.from('b'), 0, commandId)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    await expect(f.append(randomUUID())).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    await expect(f.registry.dispatch({ ...f.createCommand, path: '/etc/passwd' } as typeof f.createCommand)).rejects.toThrow()
    await expect(f.registry.dispatch({ ...f.createCommand, commandId: randomUUID(), filename: '../result.md' })).rejects.toThrow()
  })
  it.each(['noncanonical', 'oversized', 'offset'] as const)('rejects %s append without changing bytes', async kind => {
    const f = await fixture(), artifactId = await f.create()
    await expect(f.registry.dispatch({ operation: 'append', commandId: randomUUID(), artifactId,
      offset: kind === 'offset' ? 1 : 0, contentBase64: kind === 'noncanonical' ? 'Zh==' : kind === 'oversized'
        ? Buffer.alloc(64 * 1024 + 1).toString('base64') : 'YQ==' })).rejects.toThrow()
    expect((await readFile(join(f.root, artifactId))).length).toBe(0)
    await f.append(artifactId, Buffer.from('a'))
  })
  it.each(['link', 'replacement', 'changed-bytes'] as const)('rejects %s file identity before seal', async kind => {
    const f = await fixture(), artifactId = await f.create(); await f.append(artifactId)
    const path = join(f.root, artifactId), other = join(f.root, 'other')
    if (kind === 'link') await link(path, other)
    else if (kind === 'replacement') { await rename(path, other); await writeFile(path, '# replacement\n', { mode: 0o600 }) }
    else await writeFile(path, '# mutated bytes\n')
    await expect(f.seal(artifactId)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    if (kind !== 'changed-bytes') await unlink(other)
  })
  it('rejects symlink substitution with no-follow open', async () => {
    const f = await fixture(), artifactId = await f.create(), path = join(f.root, artifactId), other = join(f.root, 'other')
    await rename(path, other); await symlink(other, path)
    await expect(f.seal(artifactId)).rejects.toThrow()
    await unlink(other)
  })
  it('rejects a swapped private root before writing to either directory', async () => {
    const f = await fixture(), artifactId = await f.create(), original = `${f.root}-original`
    await rename(f.root, original); await mkdir(f.root, { mode: 0o700 })
    try {
      await expect(f.append(artifactId)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
      expect(await readdir(f.root)).toEqual([])
      expect((await readFile(join(original, artifactId))).length).toBe(0)
    } finally { await rm(f.root, { recursive: true }); await rename(original, f.root) }
  })
  it('bounds queued native bytes while an admitted command is awaiting authority', async () => {
    const f = await fixture(), artifactId = await f.create()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), resumed = new Promise<void>(resolve => { release = resolve })
    vi.mocked(f.ports.authority.assertCurrent).mockImplementationOnce(async () => { entered(); await resumed })
    const body = Buffer.alloc(64 * 1024)
    const first = f.append(artifactId, body)
    await waiting
    const queued = Array.from({ length: 64 }, () => f.append(artifactId, body))
    const outcomes = Promise.allSettled([first, ...queued])
    release()
    const results = await outcomes
    expect(results.some(result => result.status === 'rejected' && result.reason.code === 'WORKER_NATIVE_OUTPUT_UNAVAILABLE')).toBe(true)
    expect(await readFile(join(f.root, artifactId))).toEqual(body)
    await f.append(artifactId, Buffer.from('a'), body.length)
  })
  it('injects only original host scope and rejects native scope arguments', async () => {
    const f = await fixture(), artifactId = await f.create(); await f.append(artifactId); await f.seal(artifactId)
    const publication = await f.publication(artifactId)
    await expect(f.registry.dispatch({ operation: 'publish', publication: { ...publication, scope: f.scope } } as
      Parameters<WorkerNativeOutputRegistry['dispatch']>[0])).rejects.toThrow()
    expect(f.ports.publisher.publish).not.toHaveBeenCalled()
    await expect(f.registry.dispatch({ operation: 'publish', publication })).rejects.toThrow('No Main publisher')
    expect(f.ports.publisher.publish).toHaveBeenCalledWith({ ...publication, scope: f.scope }, expect.any(AbortSignal))
  })
  it('serializes append and seal, fences writes, and returns independent snapshot slices', async () => {
    const f = await fixture(), artifactId = await f.create()
    const bytes = Buffer.from('# race\n')
    await Promise.all([f.append(artifactId, bytes), f.seal(artifactId)])
    await expect(f.append(artifactId, Buffer.from('b'), bytes.length)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    const publication = await f.publication(artifactId)
    let captured: Awaited<ReturnType<WorkerNativeOutputRegistry['sealed']>> | undefined
    vi.mocked(f.ports.publisher.publish).mockImplementation(async () => { captured = await f.registry.sealed({ ...publication, scope: f.scope }); throw new Error('lost carrier') })
    await expect(f.registry.dispatch({ operation: 'publish', publication })).rejects.toThrow('lost carrier')
    const copy = await captured!.read(0, bytes.length); copy[0] = 0
    await writeFile(join(f.root, artifactId), '# later path bytes\n')
    expect(Buffer.from(await captured!.read(0, bytes.length))).toEqual(bytes)
    await expect(captured!.read(0, bytes.length + 1)).rejects.toThrow()
  })
  it('retains only the original publication command across transport retry', async () => {
    const f = await fixture(), artifactId = await f.create(); await f.append(artifactId); await f.seal(artifactId)
    const publication = await f.publication(artifactId)
    vi.mocked(f.ports.publisher.publish).mockRejectedValue(new Error('carrier lost'))
    await expect(f.registry.dispatch({ operation: 'publish', publication })).rejects.toThrow('carrier lost')
    await expect(f.registry.dispatch({ operation: 'publish', publication })).rejects.toThrow('carrier lost')
    expect(f.ports.publisher.publish).toHaveBeenCalledTimes(2)
    await expect(f.registry.dispatch({ operation: 'publish', publication: { ...publication, commandId: randomUUID() } })).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
  })
  it('rechecks source authority after actual write and refuses a partial success', async () => {
    const f = await fixture(), artifactId = await f.create()
    vi.mocked(f.ports.storage.assertProtected).mockImplementation(async () => {
      if ((await readFile(join(f.root, artifactId))).length) throw new Error('native protection withdrawn')
    })
    await expect(f.append(artifactId)).rejects.toThrow('protection withdrawn')
    vi.mocked(f.ports.storage.assertProtected).mockResolvedValue(undefined)
    await expect(f.seal(artifactId)).rejects.toThrow()
  })
  it('cleans an unacknowledged create when authority withdraws after file allocation', async () => {
    const f = await fixture()
    vi.mocked(f.ports.storage.assertProtected).mockImplementation(async () => {
      if ((await readdir(f.root)).length) throw new Error('protection withdrawn after allocation')
    })
    await expect(f.create()).rejects.toThrow('withdrawn after allocation')
    expect(await readdir(f.root)).toEqual([]); expect(f.reservation.release).toHaveBeenCalledTimes(1)
  })
  it('rejects an already aborted command before admission and withdraws idempotently', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort(new Error('native cancelled'))
    await expect(f.registry.dispatch(f.createCommand, abort.signal)).rejects.toThrow('native cancelled')
    await f.create(); await f.registry.withdraw(); await f.registry.withdraw()
    expect(await readdir(f.root)).toEqual([]); expect(f.reservation.release).toHaveBeenCalledTimes(1)
    await expect(f.create()).rejects.toThrow()
  })
  it('retains quota and reports cleanup failure when a registered file cannot be removed', async () => {
    const f = await fixture(), artifactId = await f.create(), path = join(f.root, artifactId)
    await unlink(path); await mkdir(path, { mode: 0o700 })
    await expect(f.registry.withdraw()).rejects.toThrow('Worker output cleanup failed')
    expect(f.reservation.release).not.toHaveBeenCalled()
    // Withdrawal was asserted above and closed its root FD. Remove only the
    // repeated-withdraw cleanup callback; the owned root cleanup still runs.
    cleanups.pop()
  })
  it('fences an awaited create and drains cleanup when withdrawn', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), resumed = new Promise<void>(resolve => { release = resolve })
    vi.mocked(f.ports.storage.reserve).mockImplementationOnce(async () => { entered(); await resumed; return f.reservation })
    const attempt = f.create(), rejected = expect(attempt).rejects.toThrow()
    await waiting; const closed = f.registry.withdraw(); release()
    await rejected; await closed
    expect(await readdir(f.root)).toEqual([]); expect(f.reservation.release).toHaveBeenCalledTimes(1)
  })
})
