import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { SourceManifest, SourceEntry } from '@graphql/contracts/source-materialization'
import { createSourceManifest, SOURCE_LIMITS, SourceError, sourcePath, sourceSha256, verifySourceBytes } from './manifest.js'
import type { ExclusiveSourceCapture } from './ports.js'
const execute = promisify(execFile)
export interface SourceSnapshotSink {
  /** Writes quarantined, detached bytes into the source namespace, never file revisions. */
  write(snapshotId: string, entry: SourceEntry, bytes: Uint8Array): Promise<void>
  commit(manifest: SourceManifest): Promise<void>
  abort(snapshotId: string): Promise<void>
}
export async function qualifiedGit(root: string, args: string[], maxBuffer = 2 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  const result = await execute('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'buffer', maxBuffer, timeout: SOURCE_LIMITS.preparationMs, ...(signal ? { signal } : {}),
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  })
  return result.stdout
}
/** Exact Git objects, never archive/export filters or working-tree bytes. */
export async function captureGitSource(input: { root: string; approvedSourceId: string; commit: string;
  approvedPaths: readonly string[]; executablePolicy: SourceManifest['executablePolicy']; sink: SourceSnapshotSink }): Promise<SourceManifest> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)) throw new SourceError('SOURCE_GIT_REF_INVALID', 'An exact Git commit object is required; branch names are not source pins.')
  if (await realpath(input.root) !== input.root || input.root === process.env.HOME || input.root === '/') throw new SourceError('SOURCE_ROOT_INVALID', 'An explicitly approved canonical project root is required.')
  const snapshotId = randomUUID(), entries: SourceEntry[] = [], signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  const git = (args: string[], limit = 2 * 1024 * 1024) => qualifiedGit(input.root, args, limit, signal)
  try {
    if ((await git(['rev-parse', '--show-toplevel'])).toString().trim() !== input.root) throw new SourceError('SOURCE_ROOT_INVALID', 'The approved source root must be the exact repository root.')
    const objectFormat = (await git(['rev-parse', '--show-object-format'])).toString().trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new SourceError('SOURCE_GIT_FORMAT_UNSUPPORTED', 'Unsupported Git object format.')
    const commit = (await git(['rev-parse', '--verify', `${input.commit}^{commit}`])).toString().trim()
    if (commit !== input.commit) throw new SourceError('SOURCE_GIT_REF_INVALID', 'The supplied object must itself be the exact commit.')
    const tree = (await git(['rev-parse', '--verify', `${commit}^{tree}`])).toString().trim()
    const listing = await git(['ls-tree', '-rz', '--full-tree', tree])
    const names = new Set(input.approvedPaths.map(sourcePath))
    if (names.size !== input.approvedPaths.length) throw new SourceError('SOURCE_PATH_COLLISION', 'Approvals must name each file once.')
    const records = listing.toString('utf8').split('\0').filter(Boolean)
    if (records.length > SOURCE_LIMITS.entries || !Buffer.from(listing.toString('utf8')).equals(listing)) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'The Git tree has unsupported encoding or too many entries.')
    let total = 0
    for (const record of records.sort((a, b) => a.slice(a.indexOf('\t') + 1).localeCompare(b.slice(b.indexOf('\t') + 1), 'en'))) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record)
      if (!match) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Symlinks and submodules require a separately qualified source policy.')
      const path = sourcePath(match[3]!)
      if (!names.delete(path)) throw new SourceError('SOURCE_INCLUSION_NOT_APPROVED', 'Every exact tree entry must be explicitly approved; tracked secrets are never silently omitted.')
      const size = Number((await git(['cat-file', '-s', match[2]!])).toString().trim())
      if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_LIMITS.fileBytes || (total += size) > SOURCE_LIMITS.bytes) throw new SourceError('SOURCE_CAPACITY', 'Source bytes exceed their separate source budget.')
      const bytes = await git(['cat-file', 'blob', match[2]!], SOURCE_LIMITS.fileBytes + 1)
      if (bytes.subarray(0, 200).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new SourceError('SOURCE_LFS_UNSUPPORTED', 'Pin and qualify LFS object delivery before capturing this source.')
      const entry: SourceEntry = { path, kind: 'file', byteSize: size, sha256: sourceSha256(bytes), executable: input.executablePolicy === 'preserve-approved' && match[1] === '100755' }
      verifySourceBytes(entry, bytes); await input.sink.write(snapshotId, entry, bytes); entries.push(entry)
    }
    if (names.size) throw new SourceError('SOURCE_INCLUSION_NOT_FOUND', 'Approved files are absent from the exact Git tree.')
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const manifest = createSourceManifest({ version: 1, snapshotId, approvedSourceId: input.approvedSourceId,
      capturePolicy: 'git-tree-v1', executablePolicy: input.executablePolicy, git: { commit, tree, objectFormat }, entries, deletions: [] })
    signal.throwIfAborted(); await input.sink.commit(manifest); return manifest
  } catch (error) { await input.sink.abort(snapshotId); throw error }
}
export async function captureExplicitSource(input: { capture: ExclusiveSourceCapture; entries: readonly { path: string; executable: boolean }[];
  deletions: string[]; overlayBaseDigest?: string; executablePolicy: SourceManifest['executablePolicy']; sink: SourceSnapshotSink }): Promise<SourceManifest> {
  if (input.capture.writerExcluded !== true) throw new SourceError('SOURCE_CAPTURE_UNSUPPORTED', 'A qualified writer exclusion is required for dirty or untracked capture.')
  const snapshotId = randomUUID(), entries: SourceEntry[] = [], signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  try {
    signal.throwIfAborted(); await input.capture.validateExclusion()
    if (input.entries.length > SOURCE_LIMITS.entries) throw new SourceError('SOURCE_CAPACITY', 'Too many source entries.')
    let total = 0
    for (const inclusion of input.entries) {
      signal.throwIfAborted(); sourcePath(inclusion.path)
      const bytes = await input.capture.read(inclusion)
      if (bytes.byteLength > SOURCE_LIMITS.fileBytes || (total += bytes.byteLength) > SOURCE_LIMITS.bytes) throw new SourceError('SOURCE_CAPACITY', 'Source byte budget exceeded.')
      const entry: SourceEntry = { path: inclusion.path, kind: 'file', byteSize: bytes.byteLength, sha256: sourceSha256(bytes), executable: input.executablePolicy === 'preserve-approved' && inclusion.executable }
      verifySourceBytes(entry, bytes); await input.sink.write(snapshotId, entry, bytes); entries.push(entry)
      await input.capture.validateExclusion()
    }
    await input.capture.validateExclusion()
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const manifest = createSourceManifest({ version: 1, snapshotId, approvedSourceId: input.capture.approvedSourceId,
      capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: input.executablePolicy, entries,
      deletions: [...input.deletions].sort(), ...(input.overlayBaseDigest ? { overlayBaseDigest: input.overlayBaseDigest } : {}) })
    signal.throwIfAborted(); await input.sink.commit(manifest); return manifest
  } catch (error) { await input.sink.abort(snapshotId); throw error }
}
