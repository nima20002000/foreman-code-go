import { tmpdir } from 'node:os'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { captureGitSource } from './capture.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { sourcePackageStream, VerifiedSourcePackageReader } from './operationPackage.js'
import { Readable } from 'node:stream'
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
    git: { commit, tree: git(origin, 'rev-parse', 'HEAD^{tree}'), objectFormat: 'sha1' },
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
  const chunks: Buffer[] = []
  const signal = AbortSignal.timeout(30_000)
  for await (const chunk of sourcePackageStream(manifest, store, signal)) chunks.push(chunk as Buffer)
  const reader = new VerifiedSourcePackageReader(Readable.from(chunks),
    chunks.reduce((total, chunk) => total + chunk.length, 0), signal)
  await reader.open(manifest)
  const binding = { ...f.binding, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const materializer = new PrivateSourceMaterializer(reader, async () => {}, undefined, f.ports)
  const receipt = await materializer.prepare({ manifest, binding, attempt: f.attempt(), sharedWritableTree: true,
    worktree: { repository: 'octo/site', branch: 'foreman/review/unpublished' } })
  await reader.complete()
  expect(receipt.worktree?.commit).toBe(commit)
  expect(git(sourceWorkingTreePath(receipt), 'rev-parse', 'HEAD')).toBe(commit)
  expect(await readFile(join(sourceWorkingTreePath(receipt), 'src/app.ts'), 'utf8')).toBe('unpublished source\n')
  expect(git(f.origin, 'rev-parse', 'HEAD')).toBe(f.commit)
  expect((await f.ports.git(['cat-file', '-e', ancestor],
    { cwd: f.ports.cloneDirectory('octo/site'), signal })).code).not.toBe(0)
})
