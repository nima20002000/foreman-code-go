import { constants } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MaterializationReceiptSchema, RootBindingSchema, SourceProjectQuotaSlotSchema }
  from '@foreman-code/contracts/source-materialization'
import { SourceOperationAttemptSchema, SourceOperationOwnerSchema,
  type SourceOperationOwner, type SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { SourceMaterializationRecordSchema, type SourcePreparationClosure, type SourceRootRecord }
  from '@foreman-code/contracts/source-admission'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { preparationChildrenClosed, reconcileSourcePreparation, type SourceQuotaPool } from './materialization.js'
import { removeSourceDirectory } from './quotaReclamation.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { SourceError } from './manifest.js'
import { measureRetainedMaterializationFootprint, measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'

export type SourceReclamationResult = {
  closures: SourcePreparationClosure[]
  retained?: RetainedSourceFootprint
}

async function retainedWorkingTree(directory: FileHandle, root: SourceRootRecord,
  owner: SourceOperationOwner, materializationId: string, signal: AbortSignal): Promise<RetainedSourceFootprint | null> {
  let receipt = owner.record?.receipt
  let copy: FileHandle
  try {
    copy = await openChildDirectory(directory, materializationId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return receipt?.sharedTree ? measureRetainedMaterializationFootprint(receipt) : null
  }
  try {
    const raw = await readCleanupRecord(copy, 'receipt.json', signal, 2 * 1024 * 1024)
    if (raw) receipt = z.object({ receipt: MaterializationReceiptSchema }).parse(raw).receipt
  } finally { await copy.close() }
  if (receipt) {
    if (receipt.materializationId !== materializationId || receipt.executionId !== owner.attempt.executionId
      || receipt.attemptId !== owner.attempt.attemptId || receipt.placementHash !== owner.attempt.placementHash
      || receipt.keyRevision !== owner.attempt.keyRevision
      || receipt.authorizationRevision !== owner.attempt.authorizationRevision
      || !isDeepStrictEqual(receipt.binding, root.binding)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Retained working tree belongs to another preparation.')
    }
    return receipt.sharedTree ? measureRetainedMaterializationFootprint(receipt) : null
  }
  // A worktree marker can commit before its materialization receipt.
  const markerSchema = z.object({ id: z.uuid(), executionId: z.string(), binding: RootBindingSchema })
  for (const name of (await readdir(anchored(directory))).filter(name => /^worktree-.*\.json$/.test(name))) {
    const raw = await readCleanupRecord(directory, name, signal)
    if (!raw) continue
    const marker = markerSchema.parse(raw)
    if (marker.executionId !== owner.attempt.executionId || !isDeepStrictEqual(marker.binding, root.binding)) continue
    const bytes = await measureRetainedSourceDirectory(root.binding.canonicalPath, marker.id, root.binding.filesystem)
    const reference = await measureRetainedSourceDirectory(root.binding.canonicalPath, materializationId,
      root.binding.filesystem)
    return { retainedBytes: reference + bytes, sharedTree: { id: marker.id, bytes } }
  }
  return null
}

const ClaimSchema = z.object({ version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  attempt: SourceOperationAttemptSchema, quota: SourceProjectQuotaSlotSchema.optional() }).strict()

async function readCleanupRecord(directory: FileHandle, name: string, signal: AbortSignal,
  maximumBytes = 16384): Promise<unknown | null> {
  signal.throwIfAborted()
  let file: FileHandle
  try {
    file = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
      || stat.mode & 0o077 || stat.size > maximumBytes) {
      throw new SourceError('SOURCE_CLAIM_INVALID', 'Source cleanup metadata is not a private bounded record.')
    }
    return JSON.parse(await file.readFile({ encoding: 'utf8', signal })) as unknown
  } finally {
    await file.close()
  }
}

function ownsClaim(root: SourceRootRecord, grant: SourceReservationReclamation,
  claim: ReturnType<typeof ClaimSchema.parse>): boolean {
  return isDeepStrictEqual(claim.binding, root.binding)
    && sourceOperationSelectionHash(root, claim.attempt, grant.operationId) === claim.attempt.placementHash
}

async function releasedOwner(directory: FileHandle, name: string, root: SourceRootRecord,
  grant: SourceReservationReclamation, signal: AbortSignal): Promise<SourceOperationOwner | null> {
  const copy = await openChildDirectory(directory, name)
  try {
    const raw = await readCleanupRecord(copy, 'released-claim.json', signal)
    if (!raw) return null
    const claim = ClaimSchema.parse(raw)
    if (!ownsClaim(root, grant, claim)) return null
    const metadata = z.object({ receipt: MaterializationReceiptSchema }).parse(
      await readCleanupRecord(copy, 'receipt.json', signal, 2 * 1024 * 1024))
    const receipt = metadata.receipt
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId,
      attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    if (receipt.materializationId !== name || claim.materializationId !== name
      || !isDeepStrictEqual(receipt.binding, claim.binding) || !isDeepStrictEqual(attempt, claim.attempt)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Released source metadata belongs to another copy.')
    }
    return SourceOperationOwnerSchema.parse({
      identity: { operationId: grant.operationId, ownerPrincipalId: root.ownerPrincipalId, expiresAt: grant.expiresAt },
      root, source: root.source, attempt, physicalClosureConfirmed: false,
      record: SourceMaterializationRecordSchema.parse({ receipt, operationId: grant.operationId,
        reservationId: grant.reservationId, rootPolicyId: root.selection.rootPolicyId,
        rootPolicyRevision: root.selection.rootPolicyRevision, sourceBindingHash: attempt.placementHash,
        finalDispatchBindingHash: null, state: 'closed' }),
    })
  } finally {
    await copy.close()
  }
}

async function findOwners(root: SourceRootRecord, grant: SourceReservationReclamation, signal: AbortSignal) {
  const directory = await openPrivateRoot(root.binding.canonicalPath)
  try {
    if (!isDeepStrictEqual(await identity(directory), root.binding.filesystem)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source cleanup root changed.')
    }
    const entries = await readdir(anchored(directory))
    if (entries.length > 8192) throw new SourceError('SOURCE_CAPACITY', 'Source cleanup metadata exceeds its scan limit.')
    const owners = new Map<string, SourceOperationOwner>()
    if (grant.owner && isDeepStrictEqual(grant.owner.root, root)) {
      owners.set(grant.owner.attempt.executionId, grant.owner)
    }
    for (const name of entries.filter(name => name.endsWith('.lock') || name.endsWith('.claim.json'))) {
      const raw = await readCleanupRecord(directory, name, signal)
      if (!raw) continue
      if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'qualification') continue
      const claim = ClaimSchema.parse(raw)
      if (!ownsClaim(root, grant, claim)) continue
      if (!owners.has(claim.attempt.executionId)) {
        owners.set(claim.attempt.executionId, SourceOperationOwnerSchema.parse({
          identity: { operationId: grant.operationId, ownerPrincipalId: root.ownerPrincipalId, expiresAt: grant.expiresAt },
          root, source: root.source, attempt: claim.attempt, record: null, physicalClosureConfirmed: false,
          ...(claim.quota ? { quotaRequired: true } : {}),
        }))
      }
    }
    // A released claim can precede a failed Main commit; its copy still consumes disk space.
    for (const name of entries.filter(name => z.uuid().safeParse(name).success)) {
      const owner = await releasedOwner(directory, name, root, grant, signal)
      if (owner) owners.set(owner.attempt.executionId, owner)
    }
    return [...owners.values()]
  } finally { await directory.close() }
}

export async function reclaimSourceReservation(grant: SourceReservationReclamation, ports: {
  authorize(): Promise<void>
  operationClosed(operationId: string): Promise<boolean>
  nativeClosed(owner: SourceOperationOwner): Promise<boolean>
  quotaPoolFor?(owner: SourceOperationOwner): Promise<SourceQuotaPool | undefined>
  closed?(closure: SourcePreparationClosure): Promise<void>
}, signal: AbortSignal): Promise<SourceReclamationResult> {
  let foundOwner = false
  const closures: SourcePreparationClosure[] = []
  const unmatchedRoots: SourceRootRecord[] = []
  let retained: RetainedSourceFootprint | undefined
  for (const root of grant.roots) {
    signal.throwIfAborted()
    await ports.authorize()
    const owners = await findOwners(root, grant, signal)
    if (!owners.length) unmatchedRoots.push(root)
    if (owners.length) foundOwner = true
    for (const original of owners) {
      const owner = SourceOperationOwnerSchema.parse({ ...original, preparationClosed: true,
        identity: { ...original.identity, expiresAt: grant.expiresAt } })
      const closure = await reconcileSourcePreparation(grant.reclamationId, owner,
        () => ports.nativeClosed(owner), ports.authorize, await ports.quotaPoolFor?.(owner), signal)
      await ports.closed?.(closure)
      if (closure.materializationId && !closure.quotaReclaimed) {
        await ports.authorize()
        const directory = await openPrivateRoot(root.binding.canonicalPath)
        try {
          if (!isDeepStrictEqual(await identity(directory), root.binding.filesystem)) {
            throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source cleanup root changed.')
          }
          const footprint = await retainedWorkingTree(directory, root, owner, closure.materializationId, signal)
          if (footprint) {
            if (retained) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Multiple retained working trees need reconciliation.')
            retained = footprint
          } else {
            await removeSourceDirectory(directory, closure.materializationId, { binding: root.binding }, signal)
          }
        } finally { await directory.close() }
      }
      await ports.authorize()
      closures.push(closure)
    }
  }
  if (!foundOwner) {
    for (const root of unmatchedRoots) await preparationChildrenClosed(root.binding.canonicalPath, signal)
    if (!await ports.operationClosed(grant.operationId)) {
      throw new SourceError('source-reconciliation-unconfirmed', 'Original native operation closure is unconfirmed.')
    }
  }
  await ports.authorize()
  return { closures, ...(retained ? { retained } : {}) }
}
