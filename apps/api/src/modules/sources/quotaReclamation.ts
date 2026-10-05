import { constants } from 'node:fs'
import { open, readdir, unlink, rmdir, rename, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { MaterializationReceiptSchema, type MaterializationReceipt }
  from '@foreman-code/contracts/source-materialization'
import { archiveMaterializationClaim, withClaimLock, type SourceQuotaPool } from './materialization.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { verifyJobQuotaOwnership } from '../jobs/quotaOwnership.js'
import { SourceError } from './manifest.js'

async function readRecord(root: FileHandle, name: string): Promise<unknown | null> {
  let file: FileHandle
  try { file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || stat.mode & 0o077) {
      throw new SourceError('SOURCE_CLAIM_INVALID', 'Quota cleanup record is invalid.')
    }
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally { await file.close() }
}
async function writeRecord(root: FileHandle, name: string, record: unknown): Promise<void> {
  const file = await open(anchored(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify(record)); await file.sync() }
  finally { await file.close() }
  await root.sync()
}
async function removeDirectory(parent: FileHandle, name: string,
  receipt: Pick<MaterializationReceipt, 'binding' | 'quota'>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let directory: FileHandle
  try { directory = await openChildDirectory(parent, name) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const filesystem = await identity(directory)
    if (filesystem.device !== receipt.quota!.filesystem.device
      || filesystem.mountId !== receipt.quota!.filesystem.mountId) {
      throw new SourceError('SOURCE_MOUNT_CHANGED', 'Quota cleanup cannot cross a filesystem boundary.')
    }
    for (const entry of await readdir(anchored(directory), { withFileTypes: true })) {
      signal.throwIfAborted()
      if (entry.isDirectory()) await removeDirectory(directory, entry.name, receipt, signal)
      else await unlink(anchored(directory, entry.name))
    }
  } finally { await directory.close() }
  signal.throwIfAborted()
  await rmdir(anchored(parent, name))
  await parent.sync()
}

/** Main retains the source snapshot and published artifacts before authorizing this cleanup. */
export async function reclaimMaterializationQuota(receipt: MaterializationReceipt, quotaPool: SourceQuotaPool,
  reconcile: () => Promise<'released' | 'owned' | 'uncertain'>, signal: AbortSignal): Promise<void> {
  MaterializationReceiptSchema.parse(receipt)
  if (!receipt.quota) throw new SourceError('SOURCE_QUOTA_MISSING', 'Per-Job quota ownership is missing.')
  signal.throwIfAborted()
  if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  const removingName = `reclaiming-${receipt.materializationId}.json`
  const completedName = `reclaimed-${receipt.materializationId}.json`
  try {
    if (!isDeepStrictEqual(await identity(root), receipt.binding.filesystem)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'The original quota namespace changed.')
    }
    const completed = await readRecord(root, completedName)
    if (completed) {
      if (!isDeepStrictEqual(completed, receipt)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup belongs to another Job.')
      await withClaimLock(root, async () => {
        signal.throwIfAborted()
        const name = `quota-${receipt.quota!.namespace}.claim.json`
        const active = await readRecord(root, name) as { materializationId: string } | null
        if (active?.materializationId === receipt.materializationId) {
          await rename(anchored(root, name), anchored(root, `released-quota-${receipt.materializationId}.json`))
          await root.sync()
        }
      })
      return
    }
    const removing = await readRecord(root, removingName)
    if (removing && !isDeepStrictEqual(removing, receipt)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup belongs to another Job.')
    }
    if (!removing) {
      await archiveMaterializationClaim(receipt, { filesystem: receipt.binding.filesystem }, reconcile)
      await writeRecord(root, removingName, receipt)
    }
    await withClaimLock(root, async () => {
      signal.throwIfAborted()
      if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
      const claimName = `quota-${receipt.quota!.namespace}.claim.json`
      const claim = await readRecord(root, claimName) as { materializationId: string; quota: unknown } | null
      if (!claim || claim.materializationId !== receipt.materializationId || !isDeepStrictEqual(claim.quota, receipt.quota)) {
        throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Quota cleanup does not own this slot.')
      }
      await verifyJobQuotaOwnership({ ...quotaPool, binding: receipt.binding, slot: receipt.quota!, signal })
      const slot = await openChildDirectory(root, receipt.quota!.namespace)
      try {
        await removeDirectory(slot, receipt.materializationId, receipt, signal)
        const usage = await verifyJobQuotaOwnership({ ...quotaPool, binding: receipt.binding, slot: receipt.quota!, signal })
        const stat = await slot.stat()
        if ((await readdir(anchored(slot))).length || usage.usedBytes > stat.blocks * 512 || usage.usedInodes > 1) {
          throw new SourceError('SOURCE_QUOTA_OWNED', 'The quota still contains Job data or an open deleted file.')
        }
        if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
        await writeRecord(root, completedName, receipt)
        await rename(anchored(root, claimName), anchored(root, `released-quota-${receipt.materializationId}.json`))
        await root.sync()
      } finally { await slot.close() }
    })
  } finally { await root.close() }
}

/** The caller holds the namespace lock and has archived the original incomplete claim. */
export async function reclaimPreparationQuota(
  claim: Pick<MaterializationReceipt, 'binding' | 'quota' | 'materializationId'>, root: FileHandle,
  quotaPool: SourceQuotaPool, closed: () => Promise<boolean>, signal: AbortSignal,
): Promise<void> {
  if (!claim.quota || !await closed()) throw new SourceError('SOURCE_ROOT_OWNED', 'Original preparation closure is unconfirmed.')
  const name = `quota-${claim.quota.namespace}.claim.json`
  const releasedName = `released-quota-${claim.materializationId}.json`
  const released = await readRecord(root, releasedName) as { materializationId: string; quota: unknown } | null
  if (released) {
    if (released.materializationId !== claim.materializationId || !isDeepStrictEqual(released.quota, claim.quota)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Preparation release belongs to another quota.')
    }
    return
  }
  const active = await readRecord(root, name) as { materializationId: string; quota: unknown; binding: unknown } | null
  if (!active || active.materializationId !== claim.materializationId
    || !isDeepStrictEqual(active.quota, claim.quota) || !isDeepStrictEqual(active.binding, claim.binding)) {
    throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Preparation cleanup does not own this quota.')
  }
  await verifyJobQuotaOwnership({ ...quotaPool, binding: claim.binding, slot: claim.quota, signal })
  const slot = await openChildDirectory(root, claim.quota.namespace)
  try {
    await removeDirectory(slot, claim.materializationId, claim, signal)
    const usage = await verifyJobQuotaOwnership({ ...quotaPool, binding: claim.binding, slot: claim.quota, signal })
    if ((await readdir(anchored(slot))).length || usage.usedBytes > (await slot.stat()).blocks * 512
      || usage.usedInodes > 1 || !await closed()) {
      throw new SourceError('SOURCE_QUOTA_OWNED', 'Original preparation still owns quota storage.')
    }
    await rename(anchored(root, name), anchored(root, releasedName))
    await root.sync()
  } finally { await slot.close() }
}
