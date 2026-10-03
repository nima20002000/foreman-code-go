import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { SourceManifest, SourceEntry } from '@graphql/contracts/source-materialization'
import { createSourceManifest, SOURCE_LIMITS, SourceError, sourcePath, sourceSha256, verifySourceBytes } from './manifest.js'
import type { ExclusiveSourceCapture } from './ports.js'
const execute = promisify(execFile)
const gitEnvironment = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
export interface SourceSnapshotSink {
  /** Writes quarantined, detached bytes into the source namespace, never file revisions. */
  write(snapshotId: string, entry: SourceEntry, bytes: Uint8Array): Promise<void>
  commit(manifest: SourceManifest): Promise<void>
  abort(snapshotId: string): Promise<void>
}
export async function qualifiedGit(root: string, args: string[], maxBuffer = 2 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  const result = await execute('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'buffer', maxBuffer, timeout: SOURCE_LIMITS.preparationMs, ...(signal ? { signal } : {}),
    env: gitEnvironment,
  })
  return result.stdout
}
/** One bounded Git process reads exact approved objects; each blob retains independent size/hash validation. */
async function captureBlobs(root: string, records: { path: string; mode: string; object: string }[], objectFormat: string,
  signal: AbortSignal, write: (record: typeof records[number], bytes: Buffer) => Promise<void>) {
  if (!records.length) return
  const child = spawn('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, 'cat-file', '--batch'],
    { env: gitEnvironment, signal, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { closed = true; if (code === 0) resolve(); else reject(new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'The exact Git blob reader did not complete.')) })
  })
  void finished.catch(() => {})
  child.stderr.resume(); child.stdin.on('error', () => {})
  child.stdin.end(records.map(record => `${record.object}\n`).join(''))
  const chunks = child.stdout[Symbol.asyncIterator]()
  let chunk: Buffer = Buffer.alloc(0), offset = 0
  const read = async (size: number) => {
    const bytes = Buffer.allocUnsafe(size)
    let copied = 0
    while (copied < size) {
      signal.throwIfAborted()
      if (offset === chunk.length) {
        const next = await chunks.next()
        if (next.done) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git blob output ended before the exact object was read.')
        chunk = Buffer.from(next.value); offset = 0
      }
      const length = Math.min(size - copied, chunk.length - offset)
      chunk.copy(bytes, copied, offset, offset + length); offset += length; copied += length
    }
    return bytes
  }
  let total = 0
  try {
    for (const record of records) {
      let header = ''
      for (;;) {
        const byte = (await read(1))[0]!
        if (byte === 10) break
        if (header.length >= 128) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git blob header exceeds its bound.')
        header += String.fromCharCode(byte)
      }
      const fields = /^([a-f0-9]+) blob (\d+)$/.exec(header), size = Number(fields?.[2])
      if (!fields || fields[1] !== record.object) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git returned another exact object or kind.')
      if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_LIMITS.fileBytes || (total += size) > SOURCE_LIMITS.bytes)
        throw new SourceError('SOURCE_CAPACITY', 'Source bytes exceed their separate source budget.')
      const bytes = await read(size)
      if ((await read(1))[0] !== 10 || createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== record.object)
        throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git object bytes do not match their exact accepted identity.')
      await write(record, bytes)
    }
    if (offset !== chunk.length || !(await chunks.next()).done) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Unexpected extra Git blob output.')
    await finished
  } finally {
    if (!closed) child.kill('SIGTERM')
    child.stdin.destroy()
    child.stdout.destroy()
    await exited
  }
}
/** Exact Git objects, never archive/export filters or working-tree bytes. */
export async function captureGitSource(input: { root: string; approvedSourceId: string; commit: string;
  approvedPaths: readonly string[]; snapshotId?: string; executablePolicy: SourceManifest['executablePolicy']; sink: SourceSnapshotSink }): Promise<SourceManifest> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)) throw new SourceError('SOURCE_GIT_REF_INVALID', 'An exact Git commit object is required; branch names are not source pins.')
  if (await realpath(input.root) !== input.root || input.root === process.env.HOME || input.root === '/') throw new SourceError('SOURCE_ROOT_INVALID', 'An explicitly approved canonical project root is required.')
  const snapshotId = input.snapshotId ?? randomUUID(), entries: SourceEntry[] = [], signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  const git = (args: string[], limit = 2 * 1024 * 1024) => qualifiedGit(input.root, args, limit, signal)
  try {
    if ((await git(['rev-parse', '--show-toplevel'])).toString().trim() !== input.root) throw new SourceError('SOURCE_ROOT_INVALID', 'The approved source root must be the exact repository root.')
    const objectFormat = (await git(['rev-parse', '--show-object-format'])).toString().trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new SourceError('SOURCE_GIT_FORMAT_UNSUPPORTED', 'Unsupported Git object format.')
    const objectBytes = async (kind: 'commit' | 'tree' | 'blob', object: string, limit = 2 * 1024 * 1024): Promise<Buffer> => {
      const bytes = await git(['cat-file', kind, object], limit)
      const digest = createHash(objectFormat).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
      if (digest !== object) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git object bytes do not match their exact accepted identity.')
      return bytes
    }
    const commit = input.commit, commitBytes = await objectBytes('commit', commit)
    const tree = /^tree ([a-f0-9]+)\n/.exec(commitBytes.toString('utf8'))?.[1]
    if (!tree || tree.length !== (objectFormat === 'sha1' ? 40 : 64)) throw new SourceError('SOURCE_GIT_REF_INVALID', 'The accepted commit has no exact supported tree.')
    const names = new Set(input.approvedPaths.map(sourcePath))
    if (names.size !== input.approvedPaths.length) throw new SourceError('SOURCE_PATH_COLLISION', 'Approvals must name each file once.')
    const records: { path: string; mode: string; object: string }[] = []
    let treeBytes = 0
    const readTree = async (object: string, prefix: string): Promise<void> => {
      const bytes = await objectBytes('tree', object)
      if ((treeBytes += bytes.length) > 8 * 1024 * 1024) throw new SourceError('SOURCE_CAPACITY', 'Git tree metadata exceeds the separate source budget.')
      let offset = 0
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1), width = objectFormat === 'sha1' ? 20 : 32
        if (space < offset || nul < space || nul + 1 + width > bytes.length) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Malformed Git tree encoding.')
        const mode = bytes.subarray(offset, space).toString('ascii'), nameBytes = bytes.subarray(space + 1, nul), name = nameBytes.toString('utf8')
        if (!Buffer.from(name).equals(nameBytes) || name.includes('/')) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Unsupported Git path encoding.')
        const path = sourcePath(prefix ? `${prefix}/${name}` : name), child = bytes.subarray(nul + 1, nul + 1 + width).toString('hex')
        offset = nul + 1 + width
        if (mode === '40000') await readTree(child, path)
        else if (mode === '100644' || mode === '100755') {
          records.push({ path, mode, object: child })
          if (records.length > SOURCE_LIMITS.entries) throw new SourceError('SOURCE_CAPACITY', 'Too many exact Git source entries.')
        } else throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Symlinks and submodules require a separately qualified source policy.')
      }
    }
    await readTree(tree, '')
    for (const record of records) {
      if (!names.delete(record.path)) throw new SourceError('SOURCE_INCLUSION_NOT_APPROVED', 'Every exact tree entry must be explicitly approved; tracked secrets are never silently omitted.')
    }
    if (names.size) throw new SourceError('SOURCE_INCLUSION_NOT_FOUND', 'Approved files are absent from the exact Git tree.')
    await captureBlobs(input.root, records, objectFormat, signal, async (record, bytes) => {
      if (bytes.subarray(0, 200).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new SourceError('SOURCE_LFS_UNSUPPORTED', 'Pin and qualify LFS object delivery before capturing this source.')
      const entry: SourceEntry = { path: record.path, kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: input.executablePolicy === 'preserve-approved' && record.mode === '100755' }
      verifySourceBytes(entry, bytes); await input.sink.write(snapshotId, entry, bytes); entries.push(entry)
    })
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
