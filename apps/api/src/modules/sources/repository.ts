import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MaterializationReceipt, SourceManifest } from '@graphql/contracts/source-materialization'
import { qualifiedGit } from './capture.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, verifySourceBytes, verifySourceManifest } from './manifest.js'
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
    try { await mkdir(anchored(reservation, 'repository'), { mode: 0o700 }) }
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
  return { workTree, gitDirectory, generatedCommit, sourceCommit: manifest.git?.commit ?? null }
}
