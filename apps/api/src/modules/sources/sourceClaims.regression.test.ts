import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import type { RootBinding } from '@graphql/contracts/source-materialization'
import type { MaterializationAttempt } from './ports.js'

const pauses = vi.hoisted(() => ({ beforeUnlink: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    if (String(path).endsWith('.lock') && pauses.beforeUnlink) {
      const pause = pauses.beforeUnlink; pauses.beforeUnlink = null; await pause()
    }
    return actual.unlink(path)
  } }
})
const roots: string[] = []
afterEach(async () => { pauses.beforeUnlink = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp('/tmp/source-claims-'); roots.push(root); await chmod(root, 0o700)
  const bytes = Buffer.from('accepted source\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'src/app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt: MaterializationAttempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null }
  const materializer = () => new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {})
  return { root, bytes, manifest, binding, attempt, materializer }
}

it('serializes a delayed duplicate release with successor acquisition and preserves the successor claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f), entered = deferred(), resume = deferred()
  pauses.beforeUnlink = async () => { entered.resolve(); await resume.promise }
  const delayed = releaseMaterializationClaim(receipt, async () => 'released')
  await entered.promise
  const duplicate = releaseMaterializationClaim(receipt, async () => 'released').then(() => 'released' as const, () => 'rejected' as const)
  const next = { ...f, attempt: { ...f.attempt, executionId: randomUUID(), attemptId: randomUUID() } }
  let successor
  try {
    // On the defective implementation the duplicate removes M0 while the first
    // pathname unlink is paused, letting M1 acquire before that stale unlink.
    const outcome = await Promise.race([duplicate, new Promise<'pending'>(done => setTimeout(() => done('pending'), 100))])
    if (outcome === 'released') successor = await f.materializer().prepare(next)
  } finally { resume.resolve() }
  await delayed; await duplicate
  successor ??= await f.materializer().prepare(next)
  const claim = JSON.parse(await readFile(join(f.root, `binding-${f.binding.rootId}.lock`), 'utf8')) as { materializationId: string }
  expect(claim.materializationId).toBe(successor.materializationId)
  await expect(f.materializer().prepare({ ...next, attempt: { ...next.attempt, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it('holds a kernel lock across validated claim deletion, including other processes', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f), entered = deferred(), resume = deferred()
  pauses.beforeUnlink = async () => { entered.resolve(); await resume.promise }
  const release = releaseMaterializationClaim(receipt, async () => 'released')
  await entered.promise
  try {
    await expect(promisify(execFile)('/usr/bin/flock', ['--exclusive', '--nonblock', f.root, '/usr/bin/true'])).rejects.toMatchObject({ code: 1 })
  } finally { resume.resolve(); await release }
  await promisify(execFile)('/usr/bin/flock', ['--exclusive', '--nonblock', f.root, '/usr/bin/true'])
})
