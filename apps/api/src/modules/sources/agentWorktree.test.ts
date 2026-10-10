import { closeSourceWorktree } from './worktreeCleanup.js'
import { tmpdir } from 'node:os'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceReservationReclamationSchema } from '@foreman-code/contracts/source-operations'
import { sourceBindingHash } from './bindingHash.js'
import { reclaimSourceReservation } from './reclaimSourceReservation.js'
import { measureRetainedMaterializationFootprint } from './retainedDirectoryUsage.js'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { captureGitSource } from './capture.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceWorkingTreePath } from './sourceTreePaths.js'
import { ensureClone, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import type { MaterializationAttempt } from './ports.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: gitFixtureEnvironment() }).trim()

async function fixture(options: { executablePolicy?: 'strip' | 'preserve-approved'; attributes?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-worktree-')); roots.push(base)
  const origin = join(base, 'origin'); await mkdir(join(origin, 'src'), { recursive: true })
  const bytes = Buffer.from('accepted source\n')
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'src/app.ts'), bytes)
  await chmod(join(origin, 'src/app.ts'), 0o700)
  if (options.attributes) await writeFile(join(origin, '.gitattributes'), '*.ts text eol=crlf filter=alter\n')
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'approved')
  const commit = git(origin, 'rev-parse', 'HEAD')
  const root = join(base, 'root'); await mkdir(root); await chmod(root, 0o700)
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: options.executablePolicy ?? 'preserve-approved', deletions: [],
    git: { commit, tree: git(origin, 'rev-parse', 'HEAD^{tree}'), objectFormat: 'sha1', repository: 'octo/site' },
    entries: [
      ...(options.attributes ? [{ path: '.gitattributes', kind: 'file' as const, byteSize: Buffer.byteLength('*.ts text eol=crlf filter=alter\n'),
        sha256: sourceSha256(Buffer.from('*.ts text eol=crlf filter=alter\n')), executable: false }] : []),
      { path: 'src/app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes),
        executable: options.executablePolicy !== 'strip' }] })
  const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  const ports: GitWorktreePorts = { cloneDirectory: repository => join(base, 'clones', ...repository.split('/')),
    git: (args, options) => system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
  const materializer = () => new PrivateSourceMaterializer({ async read(_pin, entry) { return entry.path === '.gitattributes'
    ? Buffer.from('*.ts text eol=crlf filter=alter\n') : bytes } }, async () => {}, undefined, ports)
  const attempt = (): MaterializationAttempt => ({ placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: null, authorizationRevision: null })
  return { base, origin, ports, commit, manifest, binding, materializer, attempt }
}

it('gives each workflow agent its own verified worktree and branch instead of one shared copy', async () => {
  const f = await fixture()
  const coder = { manifest: f.manifest, binding: f.binding, attempt: f.attempt(), sharedWritableTree: true as const,
    worktree: { repository: 'octo/site', branch: 'foreman/review/coder-run1' } }
  const reviewer = { ...coder, attempt: f.attempt(), worktree: { repository: 'octo/site', branch: 'foreman/review/reviewer-run1' } }
  const one = await f.materializer().prepare(coder)
  const two = await f.materializer().prepare(reviewer)
  expect(one.worktree).toEqual({ repository: 'octo/site', branch: expect.stringMatching(/^foreman\/review\/coder-run1-/), commit: f.commit })
  expect(two.worktree?.branch).toMatch(/^foreman\/review\/reviewer-run1-/)
  const coderTree = sourceWorkingTreePath(one), reviewerTree = sourceWorkingTreePath(two)
  expect(coderTree).not.toBe(reviewerTree)
  expect(await f.materializer().resolve(one, { binding: f.binding, attempt: coder.attempt })).toBe(coderTree)
  expect(git(coderTree, 'branch', '--show-current')).toBe(one.worktree?.branch)
  expect(await readFile(join(reviewerTree, 'src/app.ts'), 'utf8')).toBe('accepted source\n')
  // The agent edits and commits on its branch; its receipt still verifies and recovers.
  await writeFile(join(coderTree, 'src/app.ts'), 'coder edit\n')
  git(coderTree, 'commit', '-qam', 'coder work')
  await f.materializer().verify(one, { binding: f.binding, attempt: coder.attempt })
  expect(await f.materializer().prepare(coder)).toEqual(one)
  expect(await readFile(join(reviewerTree, 'src/app.ts'), 'utf8')).toBe('accepted source\n')
})

it('keeps the shared working copy for workspaces without a repository', async () => {
  const f = await fixture()
  const input = { manifest: f.manifest, binding: f.binding, attempt: f.attempt(), sharedWritableTree: true as const }
  const receipt = await f.materializer().prepare(input)
  expect(receipt.worktree).toBeUndefined()
  const other = await f.materializer().prepare({ ...input, attempt: f.attempt() })
  expect(sourceWorkingTreePath(other)).toBe(sourceWorkingTreePath(receipt))
})

it('reuses one attempt and rejects a different requested branch prefix without allocating another worktree', async () => {
  const f = await fixture()
  const input = { manifest: f.manifest, binding: f.binding, attempt: f.attempt(), sharedWritableTree: true as const,
    worktree: { repository: 'octo/site', branch: 'foreman/site/review' } }
  const receipt = await f.materializer().prepare(input)
  expect(await f.materializer().prepare(input)).toEqual(receipt)
  await expect(f.materializer().prepare({ ...input,
    worktree: { ...input.worktree, branch: 'foreman/site/substituted' } }))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_CONFLICT' })
  const repeats = await Promise.all([f.attempt(), f.attempt()].map(attempt => f.materializer().prepare({ ...input, attempt })))
  expect(new Set([receipt, ...repeats].map(value => value.worktree?.branch)).size).toBe(3)
  expect(new Set([receipt, ...repeats].map(sourceWorkingTreePath)).size).toBe(3)
  for (const repeated of repeats) expect(repeated.worktree?.commit).toBe(f.commit)
})

it('rejects a substituted repository and a branch request on a read-only root before Git allocation', async () => {
  const f = await fixture()
  const input = { manifest: f.manifest, binding: f.binding, attempt: f.attempt(), sharedWritableTree: true as const,
    worktree: { repository: 'octo/site', branch: 'foreman/site/review' } }
  await expect(f.materializer().prepare({ ...input, worktree: { ...input.worktree, repository: 'other/site' } }))
    .rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  await expect(f.materializer().prepare({ ...input, binding: { ...f.binding, accessMode: 'read-only' } }))
    .rejects.toMatchObject({ code: 'SOURCE_READ_ONLY' })
})

it('rejects a retained worktree that changed branches before supplying its working directory', async () => {
  const f = await fixture()
  const attempt = f.attempt()
  const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt,
    sharedWritableTree: true, worktree: { repository: 'octo/site', branch: 'foreman/site/review' } })
  const tree = sourceWorkingTreePath(receipt)
  git(tree, 'checkout', '-qb', 'foreman/site/replaced')
  await expect(f.materializer().resolve(receipt, { binding: f.binding, attempt }))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_CONFLICT' })
})


it.each(['strip', 'preserve-approved'] as const)('applies the %s executable policy to a tracked executable', async executablePolicy => {
  const f = await fixture({ executablePolicy })
  const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt(),
    sharedWritableTree: true, worktree: { repository: 'octo/site', branch: 'foreman/review/executable' } })
  const path = join(sourceWorkingTreePath(receipt), 'src/app.ts')
  expect(!!((await stat(path)).mode & 0o111)).toBe(executablePolicy === 'preserve-approved')
  expect(await readFile(path, 'utf8')).toBe('accepted source\n')
})

it('materializes approved raw blobs without line-ending or smudge-filter conversion', async () => {
  const f = await fixture({ attributes: true })
  const clone = await ensureClone(f.ports, 'octo/site', AbortSignal.timeout(30_000))
  git(clone, 'config', 'filter.alter.smudge', 'sed s/accepted/converted/')
  const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt(),
    sharedWritableTree: true, worktree: { repository: 'octo/site', branch: 'foreman/review/attributes' } })
  expect(await readFile(join(sourceWorkingTreePath(receipt), 'src/app.ts'), 'utf8')).toBe('accepted source\n')
  expect(git(sourceWorkingTreePath(receipt), 'rev-parse', 'HEAD')).toBe(f.commit)
})


it('prepares an approved unpublished commit on a fresh worker using the transferred objects', async () => {
  const f = await fixture()
  const main = join(f.base, 'main')
  git(f.base, 'clone', '-q', f.origin, main)
  await writeFile(join(main, 'src/app.ts'), 'private ancestor\n')
  git(main, 'commit', '-qam', 'private ancestor')
  const ancestor = git(main, 'rev-parse', 'HEAD')
  await writeFile(join(main, 'src/app.ts'), 'unpublished source\n')
  git(main, 'commit', '-qam', 'local only')
  const commit = git(main, 'rev-parse', 'HEAD')
  const canonical = join(f.base, 'snapshots')
  await mkdir(canonical, { mode: 0o700 })
  const store = new PrivateSourceSnapshotStore(canonical)
  const manifest = await captureGitSource({ root: main, commit, repository: 'octo/site',
    approvedSourceId: randomUUID(), approvedPaths: ['src/app.ts'], executablePolicy: 'strip', sink: store })
  const signal = AbortSignal.timeout(30_000)
  const reader = store
  const binding = { ...f.binding, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const materializer = new PrivateSourceMaterializer(reader, async () => {}, undefined, f.ports)
  const input = { manifest, binding, attempt: f.attempt(), sharedWritableTree: true as const,
    worktree: { repository: 'octo/site', branch: 'foreman/review/unpublished' } }
  const receipt = await materializer.prepare(input)
  expect(receipt.worktree?.commit).toBe(commit)
  expect(receipt.worktree?.startCommit).toBeUndefined()
  expect(git(sourceWorkingTreePath(receipt), 'rev-parse', 'HEAD')).toBe(commit)
  expect(await readFile(join(sourceWorkingTreePath(receipt), 'src/app.ts'), 'utf8')).toBe('unpublished source\n')
  expect(git(f.origin, 'rev-parse', 'HEAD')).toBe(f.commit)
  expect((await f.ports.git(['cat-file', '-e', ancestor],
    { cwd: f.ports.cloneDirectory('octo/site'), signal })).code).not.toBe(0)
  await materializer.verify(receipt, { binding, attempt: input.attempt })
  expect(await materializer.prepare(input)).toEqual(receipt)
})


it('preserves a closed Agent Git worktree and reports its retained bytes during reservation cleanup', async () => {
  const f = await fixture()
  const root = SourceRootRecordSchema.parse({ version: 1, binding: f.binding,
    source: { approvedSourceId: f.manifest.approvedSourceId, snapshotId: f.manifest.snapshotId,
      manifestDigest: f.manifest.manifestDigest },
    selection: { hostRef: { kind: 'main', mainId: f.binding.mainId }, rootPolicyId: randomUUID(),
      rootPolicyRevision: '1', locationRevision: '1' },
    ownerPrincipalId: 'worktree-owner', authorizedByPrincipalId: 'worktree-owner', registration: null,
    attestationId: randomUUID(), attestationDigest: 'b'.repeat(64), boundAt: new Date().toISOString() })
  const operationId = randomUUID()
  const attempt = f.attempt()
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt,
    sharedWritableTree: true, worktree: { repository: 'octo/site', branch: 'foreman/worktree-retention' } })
  const output = join(sourceWorkingTreePath(receipt), 'unintegrated.txt')
  await writeFile(output, 'Keep the Agent changes')
  const reservationId = randomUUID()
  const record = SourceMaterializationRecordSchema.parse({ receipt, operationId, reservationId,
    rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: '1', sourceBindingHash: attempt.placementHash,
    finalDispatchBindingHash: null, state: 'prepared' })
  const grant = SourceReservationReclamationSchema.parse({ operationId, reservationId, reclamationId: randomUUID(),
    scopeId: 'worktree-filesystem', expiresAt: new Date(Date.now() + 60_000).toISOString(), roots: [root],
    owner: { identity: { operationId, ownerPrincipalId: root.ownerPrincipalId,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, root, source: root.source,
      attempt, record, physicalClosureConfirmed: false } })
  const ports = { authorize: async () => {}, operationClosed: async () => true, nativeClosed: async () => true }
  for (let replay = 0; replay < 2; replay++) {
    const result = await reclaimSourceReservation(grant, ports, AbortSignal.timeout(60_000))
    expect(result.retained).toEqual(await measureRetainedMaterializationFootprint(receipt))
    expect(result.retained!.retainedBytes).toBeGreaterThan(0)
    expect(result.closures).toMatchObject([{ materializationId: receipt.materializationId, claimReleased: true }])
    expect(await readFile(output, 'utf8')).toBe('Keep the Agent changes')
    expect(git(sourceWorkingTreePath(receipt), 'branch', '--show-current')).toBe(receipt.worktree!.branch)
  }
}, 60_000)


it('cleans up committed local and Worker source worktrees and reports a dirty checkout', async () => {
  const f = await fixture()
  for (const host of ['main', 'worker']) {
    const binding = host === 'worker' ? { ...f.binding, deviceId: randomUUID(), workerInstallationId: randomUUID() } : f.binding
    const attempt = host === 'worker' ? { ...f.attempt(), keyRevision: 1, authorizationRevision: 1 } : f.attempt()
    const input = { manifest: f.manifest, binding, attempt, sharedWritableTree: true as const,
      worktree: { repository: 'octo/site', branch: `foreman/site/${host}` } }
    const receipt = await f.materializer().prepare(input)
    const directory = sourceWorkingTreePath(receipt)
    await writeFile(join(directory, 'src/app.ts'), `${host} result\n`)
    expect(await closeSourceWorktree(receipt, AbortSignal.timeout(30_000), f.ports))
      .toMatchObject({ state: 'retained', message: expect.any(String) })
    git(directory, 'commit', '-qam', 'Run result')
    const commit = git(directory, 'rev-parse', 'HEAD')
    expect(await closeSourceWorktree(receipt, AbortSignal.timeout(30_000), f.ports)).toEqual({ state: 'removed' })
    expect(git(f.ports.cloneDirectory('octo/site'), 'rev-parse', receipt.worktree!.branch)).toBe(commit)
    expect(await closeSourceWorktree(receipt, AbortSignal.timeout(30_000), f.ports)).toEqual({ state: 'removed' })
  }
})


it('starts local and Worker executions at the fetched default branch while retaining the approved reference', async () => {
  const f = await fixture()
  await writeFile(join(f.origin, 'src/app.ts'), 'latest default source\n')
  await writeFile(join(f.origin, 'new.txt'), 'new default file\n')
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Advance default branch')
  const latest = git(f.origin, 'rev-parse', 'HEAD')
  for (const host of ['main', 'worker']) {
    const binding = host === 'worker' ? { ...f.binding, deviceId: randomUUID(), workerInstallationId: randomUUID() } : f.binding
    const attempt = host === 'worker' ? { ...f.attempt(), keyRevision: 1, authorizationRevision: 1 } : f.attempt()
    const input = { manifest: f.manifest, binding, attempt, sharedWritableTree: true as const,
      worktree: { repository: 'octo/site', branch: `foreman/site/${host}-fresh` } }
    const receipt = await f.materializer().prepare(input)
    const directory = sourceWorkingTreePath(receipt)
    expect(receipt.worktree).toMatchObject({ commit: f.commit, startCommit: latest })
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(latest)
    expect(await readFile(join(directory, 'src/app.ts'), 'utf8')).toBe('latest default source\n')
    expect(await readFile(join(directory, 'new.txt'), 'utf8')).toBe('new default file\n')
    expect(await readFile(join(binding.canonicalPath, receipt.materializationId, 'tree', 'src/app.ts'), 'utf8'))
      .toBe('accepted source\n')
    await f.materializer().verify(receipt, { binding, attempt })
    expect(await f.materializer().prepare(input)).toEqual(receipt)
  }
})
