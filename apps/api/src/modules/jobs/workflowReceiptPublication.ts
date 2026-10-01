import { RemoteJobOperationReceiptSchema,type RemoteJobOperationReceipt } from '@graphql/contracts/remote-job-execution'
import type { JobExecution } from '@graphql/contracts/jobs'
import { graphSourceDigest } from '../run-graph/publication.js'
import { assertRunGraphPublication,type RunGraphPublication } from '../run-graph/publication.js'
import { readPublicNodeProjection,publicNodeProjectionFacts } from '../run-graph/publicProjection.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { repeatId } from '../runs/repeatResolution.js'
import { DomainError } from '../errors.js'
import { canonical,JobRepository } from './repository.js'
import { deriveJobReceiptLocked,type JobCanonicalOutputVerifier } from './receiptProjection.js'

/** Caller already holds the actual Job owner/receipt fence and opens the existing
 * Run publication on THAT transaction. No detached Run owner or late readback. */
export async function publishWorkflowJobReceiptLocked(publication:RunGraphPublication,execution:JobExecution,raw:RemoteJobOperationReceipt,outputs:JobCanonicalOutputVerifier):Promise<void> {
  const {sql,scope}=publication
  assertRunGraphPublication(sql,scope)
  if(!execution.workflow||execution.workflow.runId!==scope.runId||execution.workflow.workflowId!==scope.workflowId||execution.workspaceId!==scope.workspaceId)throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','Receipt publication belongs to another actual Run.',409)
  const receipt=RemoteJobOperationReceiptSchema.parse(raw),next=await deriveJobReceiptLocked(sql,execution,receipt,outputs)
  const ids=[execution.workflow.nodeId]
  await readPublicNodeProjection(sql,scope,ids) // Existing canonical domain is still unchanged here.
  const after=await readPublicNodeProjection(sql,scope,ids,{jobs:[next]})
  const facts=publicNodeProjectionFacts(after)
  if(!facts.length)throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','The accepted Job node projection is missing.',409)
  const changed=await publication.source({evidence:{sourceKind:'execution',sourceId:repeatId('job-receipt',execution.id),sourceRevision:String(receipt.sequence)},sourceDigest:graphSourceDigest(receipt),facts},async()=>{
    await new JobRepository().putExecution(sql,next)
  })
  if(!changed.replayed)Object.assign(execution,next)
  beforeGraphCommit(sql,async()=>{
    const stored=await new JobRepository().execution(sql,execution.workspaceId,execution.id)
    if(canonical(stored)!==canonical(next))throw new DomainError('JOB_RECEIPT_PIN_CONFLICT','The original receipt state changed before its graph commit.',409)
  })
}
