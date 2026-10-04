/** Worker-safe actual source filesystem operations: Node/shared contracts only. */
import { constants } from 'node:fs'
import { measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { SourceFilesystemOperationSchema, SourceOperationOwnerSchema, SourceOperationResponseSchema,
  SOURCE_OPERATION_EXTENSION, type SourceFilesystemOperation, type SourceOperationOwner, type SourceOperationResponse } from '@foreman-code/contracts/source-operations'
import { VerifiedTransferReceiptSchema, type VerifiedTransferReceipt, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { SourceManifest, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import type { SourcePreparationClosure, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceError, verifySourceManifest } from './manifest.js'
import { anchored, openPrivateRoot, openChildDirectory } from './privateFilesystem.js'
import { verifyApprovedRootAllowlist } from './rootAttestation.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim, reconcileSourcePreparation } from './materialization.js'
import { createPrivateSourceRepository } from './repository.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { assertSourceNativeSession, sourceNativeSessionContinues, verifyMaterializedWorkingDirectory } from './workingDirectory.js'
import type { SourceNativeSessionCapture, SourceInstalledNativeOwnerReader } from './executionHosts.js'
import { VerifiedSourcePackageReader } from './operationPackage.js'

export interface SourceOperationWorkerContext { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal; bytes?: Uint8Array }
export interface VerifiedSourceTransfers {
  resolveVerifiedReceipt(id: string, context: TransferContext): Promise<VerifiedTransferReceipt>
  openVerified(receipt: VerifiedTransferReceipt, context: TransferContext): Promise<Readable>
}
export interface SourceOperationWorkerOptions {
  /** Existing actual paired-main/current boot/key/auth root authentication. */
  authenticate(context: SourceOperationWorkerContext): Promise<void>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  /** Real sources.authorize on the sole authenticated W07 Main channel. */
  currentOwner(request: SourceFilesystemOperation, context: SourceOperationWorkerContext): Promise<SourceOperationOwner>
  transfers: VerifiedSourceTransfers
  transferContext(context: SourceOperationWorkerContext): Promise<TransferContext>
  /** Actual original installed native manager/session; no caller-supplied flag. */
  nativeOwnerFor?: SourceInstalledNativeOwnerReader
  /** Original protected installed Job journal. Missing evidence fails closed. */
  preparationNativeClosed?(operationId: string, owner: SourceOperationOwner): Promise<boolean>
  preparationTransfersClosed?(closure: SourcePreparationClosure, signal: AbortSignal): Promise<void>
  executionTransfersClosed?(record: SourceMaterializationRecord, signal: AbortSignal): Promise<void>
}
function attemptOf(record: NonNullable<SourceOperationOwner['record']>) {
  const r = record.receipt
  return { placementHash: r.placementHash, executionId: r.executionId, attemptId: r.attemptId, keyRevision: r.keyRevision, authorizationRevision: r.authorizationRevision }
}
function checkOwner(request: SourceFilesystemOperation, raw: SourceOperationOwner, context: SourceOperationWorkerContext): SourceOperationOwner {
  const owner = SourceOperationOwnerSchema.parse(raw), root = owner.root, binding = context.binding
  if (Date.parse(owner.identity.expiresAt) <= Date.now() || root.selection.hostRef.kind !== 'device' || root.binding.deviceId !== binding.deviceId
    || root.binding.mainId !== binding.mainId || root.binding.workerInstallationId !== binding.workerInstallationId || !root.registration
    || root.registration.workerInstallationId !== binding.workerInstallationId || root.registration.keyRevision !== binding.keyRevision
    || root.registration.authorizationRevision !== binding.authorizationRevision || owner.attempt.keyRevision !== binding.keyRevision
    || owner.attempt.authorizationRevision !== binding.authorizationRevision || sourceOperationSelectionHash(root, owner.attempt, owner.identity.operationId) !== owner.attempt.placementHash
    || !isDeepStrictEqual(owner.source, root.source)) throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source operation is not owned by the current exact authenticated main/device/attempt.')
  if (request.operation === 'sources.prepare') {
    if (!isDeepStrictEqual(request.root, root) || !isDeepStrictEqual(request.attempt, owner.attempt) || !isDeepStrictEqual(request.identity, owner.identity))
      throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Preparation cannot change the accepted original source/root/owner identity.')
  } else if (request.operation === 'sources.reconcile-preparation') {
    if (owner.preparationClosed !== true) throw new SourceError('source-reconciliation-unconfirmed', 'Original Main preparation admission is not closed.')
  } else if (!owner.record || !isDeepStrictEqual(request.record, owner.record) || request.record.operationId !== owner.identity.operationId
    || !isDeepStrictEqual(request.record.receipt.binding, root.binding) || !isDeepStrictEqual(attemptOf(request.record), owner.attempt))
    throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Source operation does not match the actual persisted materialization owner.')
  if (request.operation === 'sources.release' && !owner.physicalClosureConfirmed)
    throw new SourceError('SOURCE_EXECUTION_UNCERTAIN', 'Physical original ownership closure is not positively confirmed by Main.')
  if (request.operation === 'sources.private-repository' && root.binding.accessMode !== 'exclusive-write')
    throw new SourceError('SOURCE_READ_ONLY', 'Read-only source references cannot acquire writable repository authority.')
  return owner
}
async function localManifest(receipt: MaterializationReceipt): Promise<SourceManifest> {
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    const reservation = await openChildDirectory(root, receipt.materializationId)
    try {
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await record.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid private materialization record.')
        const value = JSON.parse(await record.readFile('utf8')) as { receipt: unknown; manifest: unknown }
        const manifest = verifySourceManifest(value.manifest)
        if (!isDeepStrictEqual(value.receipt, receipt) || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== receipt.binding.snapshotId)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Private source metadata differs from its accepted immutable receipt.')
        return manifest
      } finally { await record.close() }
    } finally { await reservation.close() }
  } finally { await root.close() }
}
export class SourceOperationWorkerService {
  private active = 0
  private readonly preparing = new Set<string>()
  constructor(private readonly options: SourceOperationWorkerOptions) {}
  private async authority(request: SourceFilesystemOperation, context: SourceOperationWorkerContext) {
    context.signal.throwIfAborted(); await this.options.authenticate(context)
    if ((context.bytes?.byteLength ?? 0) !== 0) throw new SourceError('SOURCE_OPERATION_INVALID', 'Source control operations contain no inline binary bytes.')
    const owner = checkOwner(request, await this.options.currentOwner(request, context), context)
    context.signal.throwIfAborted(); return owner
  }
  async handle(raw: unknown, context: SourceOperationWorkerContext): Promise<SourceOperationResponse> {
    const request = SourceFilesystemOperationSchema.parse(raw)
    if (Buffer.byteLength(JSON.stringify(request)) > SOURCE_OPERATION_EXTENSION.maxJsonBytes) throw new SourceError('SOURCE_CAPACITY', 'Source operation metadata exceeds its carrier budget.')
    if (this.active >= SOURCE_OPERATION_EXTENSION.maxPending) throw new SourceError('SOURCE_CAPACITY', 'Source operation capacity is exhausted.')
    this.active++
    let packageReader: VerifiedSourcePackageReader | undefined
    let preparation: string | undefined
    try {
      let owner = await this.authority(request, context)
      if (['sources.prepare', 'sources.private-repository', 'sources.reconcile-preparation'].includes(request.operation)) {
        preparation = owner.identity.operationId
        if (this.preparing.has(preparation)) { preparation = undefined; throw new SourceError('source-reconciliation-unconfirmed', 'Original source preparation is still active.') }
        this.preparing.add(preparation)
      }
      // Authenticate and resolve the actual owner before local config or target IO.
      const allowlist = ApprovedRootAllowlistSchema.parse(await this.options.approvedRoots())
      if (allowlist.hostRef.kind !== 'device' || allowlist.hostRef.mainId !== context.binding.mainId || allowlist.hostRef.deviceId !== context.binding.deviceId
        || allowlist.applicationInstallationId !== context.binding.workerInstallationId
        || owner.root.binding.canonicalPath !== join(allowlist.managedRuntimeRoot, 'source-materializations', z.uuid().parse(owner.root.selection.rootPolicyId)))
        throw new SourceError('SOURCE_ROOT_CONFLICT', 'Source paths must belong to the actual human-approved host runtime namespace.')
      await verifyApprovedRootAllowlist(allowlist)
      const reauthorize = async () => {
        const current = await this.authority(request, context)
        const { activeNativeSession: previousSession, ...previousOwner } = owner
        const { activeNativeSession: currentSession, ...currentOwner } = current
        if (!isDeepStrictEqual(currentOwner, previousOwner) || !sourceNativeSessionContinues(previousSession, currentSession)) {
          throw new SourceError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'Current source ownership changed during the filesystem operation.')
        }
        owner = current
      }
      const reader = null
      if (request.operation === 'sources.reconcile-preparation') {
        if (!this.options.preparationNativeClosed) throw new SourceError('source-reconciliation-unconfirmed', 'Original native closure evidence is unavailable.')
        const closure = await reconcileSourcePreparation(request.reconciliationId, owner,
          () => this.options.preparationNativeClosed!(owner.identity.operationId, owner), reauthorize)
        await this.options.preparationTransfersClosed?.(closure, context.signal)
        await reauthorize(); return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, closure })
      }
      if (request.operation === 'sources.prepare') {
        const materializer = new PrivateSourceMaterializer(reader, reauthorize)
        const recovered = await materializer.recover(owner.root.binding, owner.attempt)
        if (recovered) { await reauthorize(); return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, receipt: recovered }) }
        const transferContext = await this.options.transferContext(context)
        for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const)
          if (transferContext[key] !== context.binding[key]) throw new SourceError('SOURCE_TRANSFER_CONFLICT', 'Transfer reader is not bound to the actual current authenticated device.')
        const receipt = VerifiedTransferReceiptSchema.parse(await this.options.transfers.resolveVerifiedReceipt(request.package.transferId, transferContext)), intent = receipt.intent
        if (receipt.receiptId !== request.package.receiptId || receipt.sha256 !== request.package.sha256 || receipt.byteSize !== request.package.byteSize
          || intent.sha256 !== receipt.sha256 || intent.byteSize !== receipt.byteSize || intent.byteClass !== 'source' || intent.direction !== 'to-worker'
          || intent.operationId !== owner.identity.operationId || intent.executionId !== owner.attempt.executionId || intent.attemptId !== owner.attempt.attemptId
          || intent.placementHash !== owner.attempt.placementHash || intent.rootId !== owner.root.binding.rootId || intent.rootBindingRevision !== owner.root.binding.bindingRevision
          || intent.manifestDigest !== owner.source.manifestDigest) throw new SourceError('SOURCE_TRANSFER_CONFLICT', 'The verified source package belongs to another exact operation/root/snapshot.')
        for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)
          if (intent[key] !== transferContext[key]) throw new SourceError('SOURCE_TRANSFER_CONFLICT', 'The verified source package belongs to another receiver authority.')
        packageReader = new VerifiedSourcePackageReader(await this.options.transfers.openVerified(receipt, transferContext), receipt.byteSize, context.signal)
        const manifest = await packageReader.open(owner.source)
        const receiptValue = await new PrivateSourceMaterializer(packageReader, async () => { await reauthorize()
          // Complete framing is checked BEFORE activation in the materializer's
          // final authorization callback, not after a partial ready receipt.
          if (packageReader!.readyToComplete) await packageReader!.complete()
        }).prepare({ manifest, binding: owner.root.binding, attempt: owner.attempt, signal: context.signal })
        await packageReader.complete(); await reauthorize()
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, receipt: receiptValue })
      }
      const record = request.record
      const materializer = new PrivateSourceMaterializer(reader, reauthorize)
      if (request.operation === 'sources.verify') {
        let capture: SourceNativeSessionCapture | undefined
        if (owner.activeNativeSession) {
          const installed = await this.options.nativeOwnerFor?.(record), proof = owner.activeNativeSession
          if (!installed) throw new SourceError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original installed native lifetime is unavailable.')
          const assertCurrent = async () => {
            installed.signal.throwIfAborted(); context.signal.throwIfAborted()
            await reauthorize()
            if (installed.executionId !== proof.executionId || installed.runId !== proof.runId || installed.technicalAttempt !== proof.technicalAttempt || installed.attemptId !== proof.attemptId
              || installed.operationId !== proof.operationId || installed.materializationId !== proof.materializationId
              || installed.sourceBindingHash !== proof.sourceBindingHash || installed.finalDispatchBindingHash !== proof.finalDispatchBindingHash
              || !isDeepStrictEqual(installed.session, proof.nativeSession) || !isDeepStrictEqual(installed.owner, proof.owner))
              throw new SourceError('SOURCE_NATIVE_SESSION_CONFLICT', 'Main continuation evidence differs from the actual original installed native lifetime.')
            await installed.assertCurrent(); installed.signal.throwIfAborted(); context.signal.throwIfAborted()
          }
          capture = { get proof() { return owner.activeNativeSession! },
            signal: AbortSignal.any([context.signal, installed.signal]), assertCurrent }
          await assertSourceNativeSession(record, capture)
        }
        const verified = await verifyMaterializedWorkingDirectory(record, request.relativeCwd, reauthorize, capture)
        return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, workTree: verified.canonicalProjectRoot,
          canonicalCwd: verified.canonicalCwd, directoryIdentityHash: verified.directoryIdentityHash,
          filesystem: verified.cwdAttestation!.filesystem, accessMode: verified.accessMode, cwdAttestation: verified.cwdAttestation })
      }
      if (request.operation === 'sources.private-repository') {
        const manifest = await localManifest(record.receipt)
        if (manifest.approvedSourceId !== owner.source.approvedSourceId) throw new SourceError('SOURCE_PIN_CONFLICT', 'Private repository is bound to a different approved source.')
        const repository = await createPrivateSourceRepository({ receipt: record.receipt, manifest, materializer, attempt: owner.attempt, signal: context.signal }).catch((error: unknown) => {
          // W07 only sends bounded lowercase domain codes, never Error messages,
          // paths or child-process handles. Main maps this exact operation code.
          if ((error as { code?: string }).code === 'SOURCE_REPOSITORY_TIMEOUT') throw new SourceError('source-repository-timeout', 'Private source preparation timed out.')
          if ((error as { code?: string }).code === 'SOURCE_REPOSITORY_UNCERTAIN') throw new SourceError('source-repository-uncertain', 'Original private source preparation requires reconciliation.')
          throw error
        })
        await reauthorize(); return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation, repository })
      }
      await reauthorize()
      await releaseMaterializationClaim(record.receipt, async () => {
        const current = await this.authority(request, context)
        return current.physicalClosureConfirmed ? 'released' : 'uncertain'
      })
      await this.options.executionTransfersClosed?.(record, context.signal)
      await reauthorize()
      const binding = record.receipt.binding
      const retainedBytes = await measureRetainedSourceDirectory(
        binding.canonicalPath, record.receipt.materializationId, binding.filesystem,
      )
      await reauthorize()
      return SourceOperationResponseSchema.parse({ version: 1, operation: request.operation,
        materializationId: record.receipt.materializationId, operationId: record.operationId, released: true, retainedBytes })
    } finally { if (preparation) this.preparing.delete(preparation); packageReader?.close(); this.active-- }
  }
}
export function createSourceOperationWorkerHandler(options: SourceOperationWorkerOptions) {
  const service = new SourceOperationWorkerService(options)
  return (payload: unknown, context: SourceOperationWorkerContext) => service.handle(payload, context)
}
