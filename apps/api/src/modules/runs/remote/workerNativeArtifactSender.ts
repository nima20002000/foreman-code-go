import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, MAX_FILE_BYTES,
  type AgentFilePublishInput, type AgentFilePublishResult } from '@graphql/contracts/files'
import { AcceptedNodePlacementSchema, DispatchIntentSchema,
  type AcceptedNodePlacement, type DispatchIntent } from '@graphql/contracts/node-placement'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema, VerifiedTransferReceiptSchema,
  type ByteTransferPort, type TransferIntent } from '@graphql/contracts/byte-transfer'
import type { WorkflowArtifactTransferInput } from '@graphql/contracts/workflow-artifact-transfer'
import { workflowArtifactTransferManifestDigest } from '@graphql/contracts/workflow-artifact-transfer-node'
import { ResumableByteTransferSender, type TransferSenderConnection } from '../../byte-transfer/sender.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { DomainError } from '../../errors.js'

/** Only the original qualified worker registry supplies this immutable source.
 * Reads return bounded copies; no path or model-selected source is accepted. */
export interface WorkerNativeArtifactSnapshot {
  sha256: string
  byteSize: number
  assertCurrent(signal?: AbortSignal): Promise<void>
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}
export interface WorkerNativeArtifactSource {
  sealed(publication: AgentFilePublishInput, signal?: AbortSignal): Promise<WorkerNativeArtifactSnapshot>
}
export interface WorkerNativeArtifactApplication {
  admit(input: WorkflowArtifactTransferInput, signal?: AbortSignal): Promise<TransferIntent>
  publish(input: { transferId: string; publication: AgentFilePublishInput }, signal?: AbortSignal): Promise<AgentFilePublishResult>
}
export interface WorkerNativeArtifactBinding {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  /** Original verified materialization root, supplied by HRT, never native args. */
  root: Pick<TransferIntent, 'rootId' | 'rootBindingRevision'>
}
const conflict = (): never => { throw new DomainError('WORKER_NATIVE_OUTPUT_CONFLICT', 'The original worker output binding changed.', 409) }

/** Real W07 sender. All authority/storage/callback qualification stays mandatory
 * in the source producer and Main adapter; there is no production fallback. */
export class WorkerNativeArtifactSender {
  private readonly binding: WorkerNativeArtifactBinding
  constructor(binding: WorkerNativeArtifactBinding, private readonly source: WorkerNativeArtifactSource,
    private readonly main: WorkerNativeArtifactApplication, private readonly receiver: ByteTransferPort,
    private readonly connection: TransferSenderConnection) {
    this.binding = { intent: DispatchIntentSchema.parse(binding.intent), placement: AcceptedNodePlacementSchema.parse(binding.placement),
      root: structuredClone(binding.root) }
    const { intent, placement, root } = this.binding
    if (placement.hostRef.kind !== 'device' || !placement.registration || placement.payload.kind !== 'agent'
      || intent.mainId !== placement.mainId || intent.runId !== placement.runId || intent.nodeId !== placement.nodeId
      || intent.bindingHash !== placement.bindingHash || !root.rootId || !Number.isSafeInteger(root.rootBindingRevision)
      || root.rootBindingRevision < 1) conflict()
  }
  async publish(raw: AgentFilePublishInput, signal?: AbortSignal): Promise<AgentFilePublishResult> {
    const publication = AgentFilePublishInputSchema.parse(raw)
    const chat = publication.scope.chat
    if (chat.kind !== 'agent' || chat.runId !== this.binding.intent.runId || chat.executionId !== this.binding.intent.executionId) conflict()
    signal?.throwIfAborted()
    const snapshot = await this.source.sealed(publication, signal)
    const check = async () => { signal?.throwIfAborted(); await snapshot.assertCurrent(signal); signal?.throwIfAborted() }
    await check()
    if (!Number.isSafeInteger(snapshot.byteSize) || snapshot.byteSize < 0 || snapshot.byteSize > MAX_FILE_BYTES) conflict()
    const hash = createHash('sha256')
    for (let offset = 0; offset < snapshot.byteSize;) {
      const length = Math.min(BYTE_TRANSFER_POLICY.maxChunkBytes, snapshot.byteSize - offset)
      const bytes = Buffer.from(await snapshot.read(offset, length, signal))
      await check()
      if (bytes.length !== length) conflict()
      hash.update(bytes); offset += length
    }
    const sha256 = hash.digest('hex')
    if (sha256 !== snapshot.sha256) conflict()
    const declaration = { commandId: publication.commandId, sha256, byteSize: snapshot.byteSize }
    await check()
    const transfer = TransferIntentSchema.parse(await this.main.admit(declaration, signal))
    await check()
    const { intent, placement, root } = this.binding
    const registration = placement.registration!
    if (placement.hostRef.kind !== 'device' || transfer.mainId !== intent.mainId || transfer.deviceId !== placement.hostRef.deviceId
      || transfer.workerInstallationId !== registration.workerInstallationId || transfer.keyRevision !== registration.keyRevision
      || transfer.authorizationRevision !== registration.authorizationRevision || transfer.operationId !== intent.operationId
      || transfer.executionId !== intent.executionId || transfer.attemptId !== intent.attemptId || transfer.placementHash !== intent.bindingHash
      || transfer.rootId !== root.rootId || transfer.rootBindingRevision !== root.rootBindingRevision
      || transfer.direction !== 'to-main' || transfer.byteClass !== 'artifact' || transfer.sha256 !== sha256
      || transfer.byteSize !== snapshot.byteSize || transfer.manifestDigest !== workflowArtifactTransferManifestDigest(declaration)) conflict()
    // Receiver-owned retries/resume use the same frozen original bytes. No expired
    // transfer fallback: Main must explicitly support any canonical-only replay.
    const receipt = VerifiedTransferReceiptSchema.parse(await new ResumableByteTransferSender(this.receiver, {
      read: async (accepted, offset, length, bounded) => {
        await check(); bounded?.throwIfAborted()
        if (!isDeepStrictEqual(accepted, transfer)) conflict()
        const bytes = Buffer.from(await snapshot.read(offset, length, bounded))
        await check(); bounded?.throwIfAborted()
        return bytes
      },
    }, this.connection).send(transfer, signal))
    await check()
    if (!isDeepStrictEqual(receipt.intent, transfer) || receipt.transferId !== transfer.transferId
      || receipt.sha256 !== sha256 || receipt.byteSize !== snapshot.byteSize) conflict()
    const result = AgentFilePublishResultSchema.parse(await this.main.publish({ transferId: transfer.transferId, publication }, signal))
    await check()
    const { file, revision } = result.value
    if (revision.sha256 !== sha256 || revision.byteSize !== snapshot.byteSize || revision.filename !== publication.filename
      || revision.mediaType !== publication.mediaType || revision.origin !== 'agent_output'
      || fileScopeIdentity(file.scope) !== fileScopeIdentity(publication.scope)) conflict()
    return result
  }
}
