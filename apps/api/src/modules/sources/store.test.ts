import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceSnapshotStore } from './store.js'

const reads = vi.hoisted(() => ({ manifest: 0 }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]).endsWith('/manifest.json')) {
      handle.readFile = new Proxy(handle.readFile, {
        apply(read, receiver, options) {
          reads.manifest++
          return Reflect.apply(read, receiver, options)
        },
      })
    }
    return handle
  } }
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp('/tmp/graphql-source-store-')
  directories.push(directory)
  const bytes = Buffer.from('immutable source bytes\n')
  const entries = Array.from({ length: 40 }, (_, index) => ({
    path: `source-${String(index).padStart(2, '0')}.txt`, kind: 'file' as const, byteSize: bytes.length,
    sha256: sourceSha256(bytes), executable: false,
  }))
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries, deletions: [] })
  const store = new PrivateSourceSnapshotStore(directory)
  for (const entry of manifest.entries) await store.write(manifest.snapshotId, entry, bytes)
  await store.commit(manifest)
  reads.manifest = 0
  return { directory, bytes, manifest, store, signal: AbortSignal.timeout(5000) }
}

it('reads a stable manifest once while verifying every file in repeated source transfers', async () => {
  const f = await fixture()
  for (let transfer = 0; transfer < 2; transfer++) {
    for (const entry of f.manifest.entries) {
      expect(await f.store.read(f.manifest, entry, f.signal)).toEqual(f.bytes)
    }
  }
  expect(reads.manifest).toBe(1)
})

it.each(['replace', 'overwrite'] as const)('rejects a changed manifest after %s even when its size and modification time match', async method => {
  const f = await fixture()
  const entry = f.manifest.entries[0]!
  await f.store.read(f.manifest, entry, f.signal)
  const path = join(f.directory, f.manifest.snapshotId, 'manifest.json')
  const before = await stat(path)
  const changed = (await readFile(path, 'utf8')).replace(f.manifest.approvedSourceId, randomUUID())
  if (method === 'replace') {
    await writeFile(`${path}.replacement`, changed, { mode: 0o400 })
    await rename(`${path}.replacement`, path)
  } else {
    await chmod(path, 0o600)
    await writeFile(path, changed)
  }
  await utimes(path, before.atime, before.mtime)
  expect((await stat(path)).size).toBe(before.size)
  await expect(f.store.read(f.manifest, entry, f.signal)).rejects.toThrow()
  expect(reads.manifest).toBe(2)
})

it('still rejects changed source bytes after the manifest has been cached', async () => {
  const f = await fixture()
  const entry = f.manifest.entries[0]!
  await f.store.read(f.manifest, entry, f.signal)
  const path = join(f.directory, f.manifest.snapshotId, 'bytes', entry.path)
  await chmod(path, 0o600)
  await writeFile(path, Buffer.alloc(f.bytes.length, 120))
  await expect(f.store.read(f.manifest, entry, f.signal)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
  expect(reads.manifest).toBe(1)
})
