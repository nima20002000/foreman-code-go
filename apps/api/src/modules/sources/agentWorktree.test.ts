import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { PrivateSourceMaterializer } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceWorkingTreePath } from './sourceTreePaths.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import type { MaterializationAttempt } from './ports.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()

async function fixture() {
  const base = await mkdtemp('/tmp/agent-worktree-'); roots.push(base)
  const origin = join(base, 'origin'); await mkdir(join(origin, 'src'), { recursive: true })
  const bytes = Buffer.from('accepted source\n')
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'src/app.ts'), bytes)
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'approved')
  const commit = git(origin, 'rev-parse', 'HEAD')
  const root = join(base, 'root'); await mkdir(root); await chmod(root, 0o700)
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', deletions: [],
    git: { commit, tree: git(origin, 'rev-parse', 'HEAD^{tree}'), objectFormat: 'sha1' },
    entries: [{ path: 'src/app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const system = systemGitWorktreePorts()
  const ports: GitWorktreePorts = { cloneDirectory: repository => join(base, 'clones', ...repository.split('/')),
    git: (args, options) => system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
  const materializer = () => new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {}, undefined, ports)
  const attempt = (): MaterializationAttempt => ({ placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: null, authorizationRevision: null })
  return { commit, manifest, binding, materializer, attempt }
}

it('gives each workflow agent its own verified worktree and branch instead of one shared copy', async () => {
  const f = await fixture()
  const coder = { manifest: f.manifest, binding: f.binding, attempt: f.attempt(), sharedWritableTree: true as const,
    worktree: { repository: 'octo/site', branch: 'foreman/review/coder-run1' } }
  const reviewer = { ...coder, attempt: f.attempt(), worktree: { repository: 'octo/site', branch: 'foreman/review/reviewer-run1' } }
  const one = await f.materializer().prepare(coder)
  const two = await f.materializer().prepare(reviewer)
  expect(one.worktree).toEqual({ repository: 'octo/site', branch: 'foreman/review/coder-run1', commit: f.commit })
  expect(two.worktree?.branch).toBe('foreman/review/reviewer-run1')
  const coderTree = sourceWorkingTreePath(one), reviewerTree = sourceWorkingTreePath(two)
  expect(coderTree).not.toBe(reviewerTree)
  expect(await f.materializer().resolve(one, { binding: f.binding, attempt: coder.attempt })).toBe(coderTree)
  expect(git(coderTree, 'branch', '--show-current')).toBe('foreman/review/coder-run1')
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
