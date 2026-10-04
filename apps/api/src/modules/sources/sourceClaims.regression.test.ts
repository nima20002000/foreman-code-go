import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { MaterializationAttempt } from './ports.js'

const pauses = vi.hoisted(() => ({ beforeUnlink: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    if (String(path).endsWith('.lock') && pauses.beforeUnlink) {
      const pause = pauses.beforeUnlink; pauses.beforeUnlink = null; await pause()
    }
    return actual.unlink(path)
  }, rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (String(from).endsWith('.lock') && pauses.beforeUnlink) {
      const pause = pauses.beforeUnlink; pauses.beforeUnlink = null; await pause()
    }
    return actual.rename(from, to)
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

async function inFreshProcess(receipt: unknown, loseAcknowledgement = false) {
  const script = `import { releaseMaterializationClaim } from './src/modules/sources/materialization.ts';
    await releaseMaterializationClaim(JSON.parse(process.argv[1]), async () => 'released');
    process.exit(${loseAcknowledgement ? 42 : 0});`
  return promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(receipt)])
}

it('replays the exact durable release in a fresh process after a lost acknowledgement', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await expect(inFreshProcess(receipt, true)).rejects.toMatchObject({ code: 42 })
  await expect(readFile(join(f.root, `binding-${f.binding.rootId}.lock`))).rejects.toMatchObject({ code: 'ENOENT' })
  await inFreshProcess(receipt)
  expect(await readFile(join(f.root, receipt.materializationId, 'tree/src/app.ts'))).toEqual(f.bytes)
})

it('replays an old release without deleting a successor claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  const next = { ...f, attempt: { ...f.attempt, executionId: randomUUID(), attemptId: randomUUID() } }
  const successor = await f.materializer().prepare(next)
  await inFreshProcess(receipt)
  const claim = JSON.parse(await readFile(join(f.root, `binding-${f.binding.rootId}.lock`), 'utf8')) as { materializationId: string }
  expect(claim.materializationId).toBe(successor.materializationId)
  await expect(f.materializer().prepare({ ...next, attempt: { ...next.attempt, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it('rejects arbitrary missing claims without a durable original release', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await unlink(join(f.root, `binding-${f.binding.rootId}.lock`))
  await expect(releaseMaterializationClaim(receipt, async () => 'released')).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['owned', 'uncertain'] as const)('does not replay without positive reconciliation (%s)', async status => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  await expect(releaseMaterializationClaim(receipt, async () => status)).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it.each(['materializationId', 'attemptId', 'binding', 'localTreeIdentity', 'verifiedAt'] as const)('binds release evidence to the exact original receipt (%s)', async field => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  const changed = { ...receipt }
  if (field === 'binding') changed.binding = { ...receipt.binding, bindingRevision: 2 }
  else if (field === 'localTreeIdentity') changed.localTreeIdentity = { ...receipt.localTreeIdentity, inode: '9999999' }
  else if (field === 'verifiedAt') changed.verifiedAt = '2020-01-01T00:00:00.000Z'
  else changed[field] = randomUUID()
  await expect(releaseMaterializationClaim(changed, async () => 'released')).rejects.toThrow()
})

it('rejects a corrupted durable release record', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  await writeFile(join(f.root, receipt.materializationId, 'released-claim.json'), JSON.stringify({ version: 1, materializationId: randomUUID(), binding: f.binding, attempt: f.attempt }))
  await expect(releaseMaterializationClaim(receipt, async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_CLAIM_CONFLICT' })
})

it('rejects changed receipt facts before releasing an active claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await expect(releaseMaterializationClaim({ ...receipt, verifiedAt: '2020-01-01T00:00:00.000Z' }, async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_CONFLICT' })
  expect(JSON.parse(await readFile(join(f.root, `binding-${f.binding.rootId}.lock`), 'utf8'))).toMatchObject({ materializationId: receipt.materializationId })
})
