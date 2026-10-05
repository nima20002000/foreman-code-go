import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MaterializationReceiptSchema, RootBindingSchema, SourceProjectQuotaSlotSchema, type RootBinding }
  from '@foreman-code/contracts/source-materialization'
import type { JobVerificationQuotaPool } from '@foreman-code/contracts/job-verification-runtime'
import { anchored } from './privateFilesystem.js'
import { SourceError } from './manifest.js'
import type { MaterializationAttempt } from './ports.js'

const QualificationQuotaClaimSchema = z.object({ kind: z.literal('qualification'),
  qualificationId: z.uuid(), operationId: z.uuid() }).strict()
const SourceQuotaClaimSchema = z.object({
  version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  quota: SourceProjectQuotaSlotSchema,
  attempt: z.object({ placementHash: MaterializationReceiptSchema.shape.placementHash,
    executionId: MaterializationReceiptSchema.shape.executionId, attemptId: MaterializationReceiptSchema.shape.attemptId,
    keyRevision: MaterializationReceiptSchema.shape.keyRevision,
    authorizationRevision: MaterializationReceiptSchema.shape.authorizationRevision }).strict(),
}).strict()
export function sourceMaterializationClaimName(binding: RootBinding, attempt: MaterializationAttempt, quota?: unknown): string {
  if (!quota) return `binding-${binding.rootId}.lock`
  const owner = createHash('sha256').update(JSON.stringify([attempt.executionId, attempt.attemptId])).digest('hex')
  return `binding-${binding.rootId}-${owner}.lock`
}

/** The namespace lock is held by the caller. A quota claim can outlive a crash before the attempt claim was written. */
export async function restoreQuotaMaterializationClaim(root: FileHandle, binding: RootBinding,
  attempt: MaterializationAttempt, pool: JobVerificationQuotaPool): Promise<void> {
  for (const slot of pool.slots) {
    let file: FileHandle
    try { file = await open(anchored(root, `quota-${slot.namespace}.claim.json`), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) {
        throw new SourceError('SOURCE_CLAIM_INVALID', 'Quota owner record is invalid.')
      }
      bytes = await file.readFile()
    } finally { await file.close() }
    const owner = z.union([SourceQuotaClaimSchema, QualificationQuotaClaimSchema]).parse(JSON.parse(bytes.toString('utf8')))
    if ('kind' in owner) continue
    if (!isDeepStrictEqual(owner.binding, binding) || !isDeepStrictEqual(owner.attempt, attempt)) continue
    if (!isDeepStrictEqual(owner.quota, slot)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Quota configuration changed.')
    const name = sourceMaterializationClaimName(binding, attempt, pool)
    const restored = await open(anchored(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW, 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    })
    if (restored) {
      try { await restored.writeFile(bytes); await restored.sync(); await root.sync() }
      finally { await restored.close() }
    }
    return
  }
}
