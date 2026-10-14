import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { PrivateSourceMaterializer, reconcileSourcePreparation, releaseMaterializationClaim }
  from '../src/modules/sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, 'source-release-reconciliation-'))
  directories.push(root)
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const bytes = Buffer.from('accepted source\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'app.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }],
    deletions: [] })
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const operationId = randomUUID()
  const binding = { version: 1 as const, mainId, deviceId, workerInstallationId, workspaceId: 'workspace',
    rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem,
    accessMode: 'exclusive-write' as const, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const ownerRoot: SourceOperationOwner['root'] = { version: 1, source,
    selection: { hostRef: { kind: 'device', mainId, deviceId }, rootPolicyId: randomUUID(),
      rootPolicyRevision: '1', locationRevision: '1' }, binding,
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(),
    attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
  const attempt = { placementHash: '', executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1 }
  attempt.placementHash = sourceBindingHash(ownerRoot, attempt, operationId)
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
  const receipt = await materializer.prepare({ manifest, binding, attempt, sharedWritableTree: true })
  // Main lost the preparation reply, so reconciliation has no receipt yet.
  const owner: SourceOperationOwner = { identity: { operationId, ownerPrincipalId: 'owner',
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, root: ownerRoot, attempt, source,
    record: null, physicalClosureConfirmed: true, preparationClosed: true }
  await reconcileSourcePreparation(randomUUID(), owner, async () => true, async () => {})
  return { root, bytes, manifest, binding, attempt, materializer, receipt }
}

it('releases an acknowledged receipt after unacknowledged preparation reconciliation and preserves a successor', async () => {
  const f = await fixture()
  const successorInput = { manifest: f.manifest, binding: f.binding,
    attempt: { ...f.attempt, executionId: randomUUID(), attemptId: randomUUID() }, sharedWritableTree: true as const }
  const successor = await f.materializer.prepare(successorInput)
  await expect(releaseMaterializationClaim(f.receipt, async () => 'released')).resolves.toBeUndefined()
  await expect(releaseMaterializationClaim(f.receipt, async () => 'released')).resolves.toBeUndefined()
  expect(await f.materializer.prepare(successorInput)).toEqual(successor)
  expect(await readFile(join(f.root, f.receipt.materializationId, 'tree/app.txt'))).toEqual(f.bytes)
  await releaseMaterializationClaim(successor, async () => 'released')
})

it('rejects a changed archived owner rather than treating a missing active claim as released', async () => {
  const f = await fixture()
  const archive = (await readdir(f.root)).find(name => name.endsWith('.claim.json'))!
  const path = join(f.root, archive)
  const claim = JSON.parse(await readFile(path, 'utf8')) as { attempt: { attemptId: string } }
  claim.attempt.attemptId = randomUUID()
  await writeFile(path, JSON.stringify(claim), { mode: 0o600 })
  await expect(releaseMaterializationClaim(f.receipt, async () => 'released'))
    .rejects.toMatchObject({ code: 'SOURCE_CLAIM_CONFLICT' })
})

it('reports missing ownership evidence as a source error and refuses cleanup without closure', async () => {
  const f = await fixture()
  await expect(releaseMaterializationClaim(f.receipt, async () => 'owned'))
    .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
  for (const name of await readdir(f.root)) {
    if (name.endsWith('.claim.json')) await rm(join(f.root, name))
  }
  await expect(releaseMaterializationClaim(f.receipt, async () => 'released'))
    .rejects.toMatchObject({ code: 'SOURCE_CLAIM_MISSING' })
})
