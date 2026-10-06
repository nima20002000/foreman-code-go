import type { TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { VerifiedArtifactReader } from '../distributed/publication.js'
import { DomainError } from '../../errors.js'
import type { JobOutputPublicationInput, TrustedJobOutputReader } from './port.js'

export interface AcceptedJobTransferResolver {
  /** Main resolves a durable admitted output intent and current W07 connection authority.
   * Worker/tool arguments cannot supply transfer IDs, root bindings or stronger principals. */
  resolve(input: JobOutputPublicationInput, execution: JobExecutionRecord): Promise<{transferId:string;context:TransferContext}>
}
export class VerifiedJobOutputReader implements TrustedJobOutputReader {
  constructor(private readonly transfers: VerifiedArtifactReader, private readonly accepted: AcceptedJobTransferResolver) {}
  async open(input: JobOutputPublicationInput, execution: JobExecutionRecord) {
    const accepted = await this.accepted.resolve(input,execution)
    const receipt = await this.transfers.resolveVerifiedReceipt(accepted.transferId,accepted.context)
    const i = receipt.intent, target = execution.acceptedSpec.target
    if (receipt.transferId!==accepted.transferId || i.executionId!==execution.id || i.attemptId!==execution.attemptId
      || i.direction!=='to-main' || i.byteClass!=='artifact' || i.placementHash!==execution.acceptedSpec.bindingHash
      || i.manifestDigest!==execution.acceptedSpec.outputSpecDigest || receipt.sha256!==input.sha256 || receipt.byteSize!==input.byteSize
      || i.sha256!==receipt.sha256 || i.byteSize!==receipt.byteSize || i.mainId!==target.mainId
      || (target.hostRef.kind==='device' && (i.deviceId!==target.hostRef.deviceId || i.workerInstallationId!==target.registration?.workerInstallationId))
      || i.keyRevision!==accepted.context.keyRevision || i.authorizationRevision!==accepted.context.authorizationRevision) {
      throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Verified transfer does not belong to the exact accepted job output.',409)
    }
    return this.transfers.openVerified(receipt,accepted.context)
  }
}
