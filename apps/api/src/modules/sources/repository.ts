import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { MaterializationReceipt, SourceManifest } from '@graphql/contracts/source-materialization'
import { qualifiedGit } from './capture.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, sourceSha256, verifySourceBytes, verifySourceManifest } from './manifest.js'
import type { MaterializationAttempt, SourceMaterializationPort } from './ports.js'

/** CI gets a freshly generated object database and explicit Git environment.
 * It contains this approved snapshot only, with no source hooks/config/helpers,
 * no shared .git and no implied approval to transfer repository history.
 */
export async function createPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; manifest: SourceManifest; materializer: SourceMaterializationPort;
  attempt: MaterializationAttempt;
}): Promise<{ workTree: string; gitDirectory: string; generatedCommit: string; sourceCommit: string | null }> {
  const manifest = verifySourceManifest(input.manifest), receipt = input.receipt
  if (manifest.snapshotId !== receipt.binding.snapshotId || manifest.manifestDigest !== receipt.verifiedManifestDigest)
    throw new SourceError('SOURCE_PIN_CONFLICT', 'Repository generation requires the accepted complete source snapshot.')
  const expected = { binding: receipt.binding, attempt: input.attempt }
  const workTree = await input.materializer.resolve(receipt, expected)
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  let gitDirectory: string
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await openChildDirectory(root, receipt.materializationId)
    try {
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (prior) {
        return await readPrivateRepository(prior, reservation, receipt, manifest, workTree)
      }
      await mkdir(anchored(reservation, 'repository'), { mode: 0o700 })
    }
    finally { await reservation.close() }
    gitDirectory = join(receipt.binding.canonicalPath, receipt.materializationId, 'repository')
  } finally { await root.close() }
  // Every Git subprocess uses only this new store, qualified system Git, no
  // global/system config, no replace refs, no hooks and no interactive prompts.
  await qualifiedGit(gitDirectory, ['init', '--bare', '--template=', `--object-format=${manifest.git?.objectFormat ?? 'sha1'}`])
  for (const entry of manifest.entries) {
    const object = (await qualifiedGit(gitDirectory, ['hash-object', '-w', '--no-filters', '--', join(workTree, entry.path)])).toString().trim()
    verifySourceBytes(entry, await qualifiedGit(gitDirectory, ['cat-file', 'blob', object], entry.byteSize + 1))
    await qualifiedGit(gitDirectory, ['update-index', '--add', '--cacheinfo', entry.executable ? '100755' : '100644', object, entry.path])
  }
  const tree = (await qualifiedGit(gitDirectory, ['write-tree'])).toString().trim()
  const generatedCommit = (await qualifiedGit(gitDirectory, ['-c', 'user.name=GraphQL Source', '-c', 'user.email=source@graphql.invalid', 'commit-tree', tree, '-m', `Source snapshot ${manifest.snapshotId}\nManifest ${manifest.manifestDigest}`])).toString().trim()
  await qualifiedGit(gitDirectory, ['update-ref', 'HEAD', generatedCommit])
  await qualifiedGit(gitDirectory, ['config', 'core.bare', 'false'])
  await qualifiedGit(gitDirectory, ['config', 'core.worktree', workTree])
  await input.materializer.verify(receipt, expected)
  const owner = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    const reservation = await openChildDirectory(owner, receipt.materializationId)
    try {
      const repository = await openChildDirectory(reservation, 'repository')
      let configDigest: string
      try {
        const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { configDigest = sourceSha256(await config.readFile()) } finally { await config.close() }
      } finally { await repository.close() }
      const record = await open(anchored(reservation, 'repository-receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await record.writeFile(JSON.stringify({ materializationId: receipt.materializationId, manifestDigest: manifest.manifestDigest,
        receiptDigest: sourceSha256(Buffer.from(JSON.stringify(receipt))), generatedCommit, configDigest })); await record.sync() }
      finally { await record.close() }
      await reservation.sync(); await owner.sync()
    } finally { await reservation.close() }
  } finally { await owner.close() }
  return { workTree, gitDirectory, generatedCommit, sourceCommit: manifest.git?.commit ?? null }
}

/** Verify only the retained original repository. Missing receipts fail closed;
 * this path cannot initialize Git, write objects or replace source state. */
export async function verifyPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; materializer: SourceMaterializationPort; attempt: MaterializationAttempt;
}) {
  const receipt = input.receipt
  const workTree = await input.materializer.resolve(receipt, { binding: receipt.binding, attempt: input.attempt })
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await openChildDirectory(root, receipt.materializationId)
    try {
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let manifest: SourceManifest
      try {
        const stat = await record.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid original source receipt.')
        const stored = JSON.parse(await record.readFile('utf8')) as { receipt: MaterializationReceipt; manifest: SourceManifest }
        manifest = verifySourceManifest(stored.manifest)
        if (!isDeepStrictEqual(stored.receipt, receipt) || manifest.snapshotId !== receipt.binding.snapshotId
          || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Stored source receipt changed.')
      } finally { await record.close() }
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      return await readPrivateRepository(prior, reservation, receipt, manifest, workTree)
    } finally { await reservation.close() }
  } finally { await root.close() }
}

async function readPrivateRepository(prior: FileHandle, reservation: FileHandle, receipt: MaterializationReceipt, manifest: SourceManifest, workTree: string) {
  try {
    const stat = await prior.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Invalid private repository receipt.')
    const saved = JSON.parse(await prior.readFile('utf8')) as { materializationId: string; manifestDigest: string; receiptDigest: string; generatedCommit: string; configDigest: string }
    const repository = await openChildDirectory(reservation, 'repository')
    try {
      const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await config.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || sourceSha256(await config.readFile()) !== saved.configDigest)
          throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository configuration changed.')
      } finally { await config.close() }
    } finally { await repository.close() }
    const gitDirectory = join(receipt.binding.canonicalPath, receipt.materializationId, 'repository')
    if (saved.materializationId !== receipt.materializationId || saved.manifestDigest !== manifest.manifestDigest
      || saved.receiptDigest !== sourceSha256(Buffer.from(JSON.stringify(receipt))) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.generatedCommit)
      || (await qualifiedGit(gitDirectory, ['rev-parse', 'HEAD'])).toString().trim() !== saved.generatedCommit)
      throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository no longer matches the original materialization.')
    return { workTree, gitDirectory, generatedCommit: saved.generatedCommit, sourceCommit: manifest.git?.commit ?? null }
  } finally { await prior.close() }
}
