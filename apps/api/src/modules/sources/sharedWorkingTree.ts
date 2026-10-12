import { approvedGitTreePaths, captureGitSource } from './capture.js'
import { processSourceDirectories, withSourceTreeWriter } from './entryProcessing.js'
import { latestDefaultCommit } from './defaultBranch.js'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { RootBindingSchema, type RootBinding, type MaterializationReceipt,
  type SourceManifest } from '@foreman-code/contracts/source-materialization'
import { anchored, entryParent, identity, openChildDirectory } from './privateFilesystem.js'
import { SourceError, verifySourceBytes } from './manifest.js'
import { join } from 'node:path'
import { addGitWorktree, ensureCommit, type GitWorktreePorts, type WorktreeRequest } from './gitWorktree.js'
import { componentLogger } from '../diagnostics/logger.js'

const SharedTreeSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  binding: RootBindingSchema,
  filesystem: RootBindingSchema.shape.filesystem,
}).strict()

function markerName(binding: RootBinding): string {
  return `working-tree-${binding.rootId}-${binding.bindingRevision}.json`
}

async function readMarker<T extends z.ZodType = typeof SharedTreeSchema>(root: FileHandle, name: string,
  schema: T = SharedTreeSchema as unknown as T): Promise<z.infer<T> | null> {
  let file: FileHandle
  try { file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || stat.mode & 0o077 || stat.size > 16384) {
      throw new SourceError('SOURCE_TREE_INVALID', 'Shared working tree metadata is invalid.')
    }
    return schema.parse(JSON.parse(await file.readFile('utf8')))
  } finally { await file.close() }
}

async function assertTree(root: FileHandle, record: z.infer<typeof SharedTreeSchema>, binding: RootBinding) {
  if (!isDeepStrictEqual(record.binding, binding)) {
    throw new SourceError('SOURCE_PIN_CONFLICT', 'Shared working tree belongs to another approved source binding.')
  }
  const directory = await openChildDirectory(root, record.id)
  try {
    const tree = await openChildDirectory(directory, 'tree')
    try {
      if (!isDeepStrictEqual(await identity(tree), record.filesystem)) {
        throw new SourceError('SOURCE_TREE_CHANGED', 'Shared working tree identity changed.')
      }
    } finally { await tree.close() }
  } finally { await directory.close() }
  return record
}

async function copyEntries(reference: FileHandle, target: FileHandle, manifest: SourceManifest, signal: AbortSignal) {
  await processSourceDirectories(target, manifest.entries, async (parent, entries) => {
    const original = await entryParent(reference, entries[0]!.path, false)
    try {
      for (const entry of entries) {
        signal.throwIfAborted()
        const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
        const file = await open(anchored(original.parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize) {
            throw new SourceError('SOURCE_TREE_INVALID', 'The approved source reference changed.')
          }
          const bytes = await file.readFile({ signal })
          verifySourceBytes(entry, bytes)
          await writeEntry(parent, entry, bytes)
        } finally { await file.close() }
      }
    } finally { await original.parent.close() }
  }, { create: true, signal })
}

async function writeEntry(parent: FileHandle, entry: SourceManifest['entries'][number], bytes: Uint8Array) {
  const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
  const file = await open(anchored(parent, leaf),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(bytes)
    await file.chmod(entry.executable ? 0o700 : 0o600)
    await file.sync()
  } finally { await file.close() }
}

/** The caller holds the root mutation lock only while initializing the shared directory. */
export async function prepareSharedWorkingTree(input: {
  root: FileHandle
  binding: RootBinding
  manifest: SourceManifest
  reference: FileHandle
  authorize(): Promise<void>
  signal: AbortSignal
}) {
  const { root, binding, manifest, reference, signal } = input
  const name = markerName(binding)
  const existing = await readMarker(root, name)
  if (existing) return assertTree(root, existing, binding)
  const pendingName = `${name}.pending`
  try {
    const pending = await open(anchored(root, pendingName), constants.O_RDONLY | constants.O_NOFOLLOW)
    await pending.close()
    throw new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'Shared working tree initialization requires reconciliation.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const id = randomUUID()
  const pending = await open(anchored(root, pendingName),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await pending.writeFile(JSON.stringify({ version: 1, id, binding }))
    await pending.sync()
  } finally { await pending.close() }
  await root.sync()
  await mkdir(anchored(root, id), { mode: 0o700 })
  const directory = await openChildDirectory(root, id)
  try {
    await mkdir(anchored(directory, 'staging'), { mode: 0o700 })
    const tree = await openChildDirectory(directory, 'staging')
    let filesystem: RootBinding['filesystem']
    try {
      await copyEntries(reference, tree, manifest, signal)
      await input.authorize()
      signal.throwIfAborted()
      filesystem = await identity(tree)
      await tree.sync()
    } finally { await tree.close() }
    await rename(anchored(directory, 'staging'), anchored(directory, 'tree'))
    await directory.sync()
    const record = SharedTreeSchema.parse({ version: 1, id, binding, filesystem })
    const file = await open(anchored(root, pendingName), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    await rename(anchored(root, pendingName), anchored(root, name))
    await root.sync()
    return record
  } finally { await directory.close() }
}

export async function verifySharedWorkingTree(root: FileHandle, receipt: MaterializationReceipt): Promise<void> {
  if (!receipt.sharedTree) return
  if (receipt.worktree) {
    const raw = await readMarker(root, worktreeMarker(receipt.sharedTree.id), WorktreeMarkerSchema)
    if (!raw || raw.id !== receipt.sharedTree.id || raw.executionId !== receipt.executionId
      || !isDeepStrictEqual(raw.filesystem, receipt.localTreeIdentity)
      || !isDeepStrictEqual(raw.worktree, receipt.worktree)) {
      throw new SourceError('SOURCE_TREE_CHANGED', 'The execution is not bound to its original agent worktree.')
    }
    await assertTree(root, raw, receipt.binding)
    return
  }
  const record = await readMarker(root, markerName(receipt.binding))
  if (!record || record.id !== receipt.sharedTree.id
    || !isDeepStrictEqual(record.filesystem, receipt.localTreeIdentity)) {
    throw new SourceError('SOURCE_TREE_CHANGED', 'The execution is not bound to its original shared working tree.')
  }
  await assertTree(root, record, receipt.binding)
}

const WorktreeMarkerSchema = SharedTreeSchema.extend({
  executionId: z.string().min(1),
  worktree: z.object({ repository: z.string(), branch: z.string(), commit: z.string(), startCommit: z.string().optional() }).strict(),
}).strict()
const worktreeMarker = (id: string) => `worktree-${id}.json`

/** One writable git worktree per agent execution, verified against the approved manifest before it is used. */
export async function prepareAgentWorktree(input: {
  root: FileHandle
  binding: RootBinding
  executionId: string
  manifest: SourceManifest
  reference: FileHandle
  request: WorktreeRequest
  ports: GitWorktreePorts
  authorize(): Promise<void>
  signal: AbortSignal
}) {
  const { root, binding, manifest, signal } = input
  const started = performance.now()
  const commit = manifest.git?.commit
  if (!commit) throw new SourceError('SOURCE_WORKTREE_INVALID', 'Only Git sources can become agent worktrees.')
  const clone = await ensureCommit(input.ports, input.request.repository, commit, signal)
  const defaultCommit = await latestDefaultCommit(input.ports, clone, signal)
  // Transferred approvals omit parent history; walk only the fetched default branch.
  const history = await input.ports.git(['rev-list', defaultCommit], { cwd: clone, signal })
  if (history.code !== 0) {
    throw new SourceError('SOURCE_WORKTREE_FAILED', 'The default branch history could not be read.')
  }
  const startCommit = history.stdout.split('\n').includes(commit) ? defaultCommit : commit
  const selected = performance.now()
  const id = randomUUID()
  await mkdir(anchored(root, id), { mode: 0o700 })
  const path = join(binding.canonicalPath, id, 'tree')
  const added = await addGitWorktree(input.ports, input.request, startCommit, path, signal, { checkout: 'deferred' })
  const allocated = performance.now()
  const directory = await openChildDirectory(root, id)
  try {
    const tree = await openChildDirectory(directory, 'tree')
    let filesystem: RootBinding['filesystem']
    try {
      if (startCommit === commit) {
        await copyEntries(input.reference, tree, manifest, signal)
        await verifyWorktreeContent(tree, manifest, signal)
      } else {
        // Keep the approved reference; bootstrap the writable checkout from verified Git objects.
        const paths = await approvedGitTreePaths(clone, startCommit)
        const current = await withSourceTreeWriter(tree, paths, write => captureGitSource({
          root: clone, approvedSourceId: manifest.approvedSourceId, commit: startCommit,
          repository: input.request.repository, approvedPaths: paths, executablePolicy: manifest.executablePolicy,
          sink: { write: async (_snapshot, entry, bytes) => write(entry, bytes),
            commit: input.authorize, abort: async () => { signal.throwIfAborted() } },
        }), writeEntry, signal)
        await verifyWorktreeContent(tree, current, signal)
      }
      await input.authorize()
      filesystem = await identity(tree)
    } finally { await tree.close() }
    const record = WorktreeMarkerSchema.parse({ version: 1, id, binding, filesystem, executionId: input.executionId,
      worktree: { repository: input.request.repository, branch: added.branch, commit, ...(startCommit !== commit ? { startCommit } : {}) } })
    const file = await open(anchored(root, worktreeMarker(id)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    await root.sync()
    componentLogger('engine').info({ executionId: input.executionId, snapshotId: manifest.snapshotId,
      durationMs: Math.round(performance.now() - started),
      fetchAndSelectMs: Math.round(selected - started), allocationMs: Math.round(allocated - selected),
      populateVerifyAndActivateMs: Math.round(performance.now() - allocated) }, 'source worktree prepared')
    return record
  } finally { await directory.close() }
}

/** The worktree holds exactly the approved files plus Git's own `.git` link file. */
async function verifyWorktreeContent(tree: FileHandle, manifest: SourceManifest, signal: AbortSignal) {
  await processSourceDirectories(tree, manifest.entries, async (parent, entries) => {
    for (const entry of entries) {
      signal.throwIfAborted()
      const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      const file = await open(anchored(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== entry.byteSize || !!(stat.mode & 0o111) !== entry.executable) {
          throw new SourceError('SOURCE_TREE_INVALID', 'The agent worktree differs from the approved source.')
        }
        verifySourceBytes(entry, await file.readFile())
      } finally { await file.close() }
    }
  }, { signal })
}
