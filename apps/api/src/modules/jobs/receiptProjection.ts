import { JobExecutionSchema, type JobExecution } from '@graphql/contracts/jobs'
import { RemoteJobOperationReceiptSchema, type RemoteJobOperationReceipt } from '@graphql/contracts/remote-job-execution'
import { DomainError } from '../errors.js'
import { canonical, JobRepository, type JobSql } from './repository.js'
export interface JobCanonicalOutputVerifier {verifyRequiredOutputs(sql:JobSql,execution:JobExecution):Promise<void>}
/** Inside the original main owner transaction. Native exit and output delivery remain separate facts. */
export async function projectJobReceiptLocked(sql:JobSql,execution:JobExecution,raw:RemoteJobOperationReceipt,outputs:JobCanonicalOutputVerifier):Promise<void> {
  const receipt=RemoteJobOperationReceiptSchema.parse(raw)
  if(receipt.intent.executionId!==execution.id||receipt.intent.attemptId!==execution.attemptId||receipt.intent.bindingHash!==execution.acceptedSpec.bindingHash) throw new DomainError('JOB_RECEIPT_PIN_CONFLICT','Observed receipt does not match accepted job facts.',409)
  if(canonical(receipt.execution.acceptedSpec)!==canonical(execution.acceptedSpec)) throw new DomainError('JOB_RECEIPT_SPEC_CONFLICT','Observed job specification changed after acceptance.',409)
  execution.transport='connected';execution.lastSeenAt=receipt.observedAt;execution.updatedAt=receipt.observedAt
  if(receipt.native?.startedAt) {
    if(execution.startedAt&&execution.startedAt!==receipt.native.startedAt)throw new DomainError('JOB_PROCESS_IDENTITY_CONFLICT','Original process start observation is immutable.',409)
    execution.startedAt=receipt.native.startedAt
  }
  if(receipt.terminal) {
    const terminal=receipt.terminal
    const process={phase:'terminal' as const,outcome:terminal.outcome,exitCode:terminal.exitCode,signal:terminal.signal,processStopped:terminal.processStopped}
    if(execution.process.phase==='terminal'&&(canonical(execution.process)!==canonical(process)||execution.finishedAt!==terminal.finishedAt)) throw new DomainError('JOB_TERMINAL_CONFLICT','Original process result is immutable.',409)
    execution.process=process;execution.finishedAt=terminal.finishedAt
    if(terminal.logGapPossible)execution.resultIssue='log_delivery_unknown'
    else if(execution.resultIssue==='log_delivery_unknown')execution.resultIssue=null
    if(terminal.logsTruncated)execution.resultIssue='log_overflow'
    if(receipt.publication==='complete') {
      try {await outputs.verifyRequiredOutputs(sql,execution);execution.publication='complete'} catch(error) {
        if(!(error instanceof DomainError))throw error
        execution.publication='failed';execution.resultIssue=error instanceof DomainError&&error.code==='JOB_REQUIRED_OUTPUT_MISSING'?'missing_output':'publication_failed'
      }
    } else if(receipt.publication==='failed'||terminal.outputCollectionError) {execution.publication='failed';execution.resultIssue='publication_failed'}
    else execution.publication='collecting'
  } else if(execution.process.phase!=='terminal') {
    if(receipt.phase==='running'||receipt.phase==='start_acknowledged')execution.process.phase='running'
    else if(receipt.phase==='native_entry_attempted')execution.process.phase='preparing'
  }
  await new JobRepository().putExecution(sql,JobExecutionSchema.parse(execution))
}
