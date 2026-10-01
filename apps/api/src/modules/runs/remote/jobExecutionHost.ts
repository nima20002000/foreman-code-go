import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { JobExecutionSchema, type JobExecution } from '@graphql/contracts/jobs'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { RemoteJobExecutionRpcRequestSchema, type RemoteJobDispatchIntent, type RemoteJobConnectionIdentity,
  type RemoteJobOwnerControl, type RemoteJobOperationReceipt, type RemoteJobTerminalEvidence } from '@graphql/contracts/remote-job-execution'
import { executeJob, jobSupervisorIdentity, type JobExecutorPorts, type JobExecutorResult } from '../../jobs/executor.js'
import type { PodmanJobSupervisor } from '../../jobs/executorPodman.js'
import type { RemoteOperationJournal } from './operationJournal.js'

const digest = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
export interface RemoteJobExecutionHostPorts {
  journal: RemoteOperationJournal
  connection: RemoteJobConnectionIdentity
  incarnationId: string
  supervisor: PodmanJobSupervisor
  source: JobExecutorPorts['source']
  appendLog: JobExecutorPorts['appendLog']
  /** Uses main's live, exact job grant; never an SQL connection on the worker. */
  authorize(intent: RemoteJobDispatchIntent, execution: JobExecution, action: 'start'|'read'|'control'|'publish'): Promise<void>
  /** Actual main PostgresJobDispatch.observeReceipt ingress; closure acknowledged before bytes publish. */
  observeReceipt(receipt: RemoteJobOperationReceipt): Promise<void>
  collectOutputs: JobExecutorPorts['collectOutputs']
}
export class RemoteJobExecutionHost {
  private readonly tasks = new Map<string, { controller: AbortController; task: Promise<void> }>()
  constructor(private readonly ports: RemoteJobExecutionHostPorts) {}
  private validate(intent: RemoteJobDispatchIntent, execution: JobExecution) {
    const target = execution.acceptedSpec.target, connection = this.ports.connection
    const subject = execution.workflow ? { kind: 'workflow-node', workspaceId: execution.workspaceId, ...execution.workflow }
      : { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId }
    if (intent.executionId !== execution.id || intent.operationId !== execution.operationId || intent.attemptId !== execution.attemptId
      || intent.bindingHash !== execution.acceptedSpec.bindingHash || intent.inputDigest !== `sha256:${execution.acceptedSpec.specDigest}`
      || !isDeepStrictEqual(intent.owner, execution.owner) || !isDeepStrictEqual(intent.subject, subject) || target.mainId !== intent.mainId
      || target.mainId !== connection.mainId) throw new Error('Job dispatch does not match its actual immutable subject')
    if (target.hostRef.kind === 'device') {
      if (!('deviceId' in connection) || connection.deviceId !== target.hostRef.deviceId || connection.workerInstallationId !== target.registration?.workerInstallationId
        || connection.keyRevision !== target.registration.keyRevision || connection.authorizationRevision !== target.registration.authorizationRevision) throw new Error('Job worker registration mismatch')
    } else if (!('kind' in connection) || connection.kind !== 'main' || connection.mainInstallationId !== target.mainInstallationId) throw new Error('Job main installation mismatch')
  }
  async handle(raw: unknown) {
    const frame = RemoteJobExecutionRpcRequestSchema.parse(raw)
    if (frame.method === 'job-dispatch') return this.deliver(frame.intent, frame.execution)
    const status = await this.ports.journal.jobStatus(frame.intent.operationId)
    if (status.status !== 'known') return status
    if (!isDeepStrictEqual(status.receipt.intent, frame.intent)) throw new Error('Stale job RPC owner')
    this.validate(frame.intent, status.receipt.execution)
    await this.ports.authorize(frame.intent, status.receipt.execution, frame.method === 'job-control' ? 'control' : 'read')
    if (frame.method === 'job-control') return this.control(frame.command)
    return this.reconcile(status.receipt)
  }
  async deliver(intent: RemoteJobDispatchIntent, raw: JobExecution) {
    const execution = JobExecutionSchema.parse(raw)
    this.validate(intent, execution)
    await this.ports.authorize(intent, execution, 'start')
    await this.ports.journal.jobAccept(intent, execution, this.ports.connection, this.ports.incarnationId)
    const status = await this.ports.journal.jobStatus(intent.operationId)
    if (status.status !== 'known') return status
    if (this.tasks.has(intent.operationId) || status.receipt.phase !== 'received') return status
    const controller = new AbortController()
    const task = this.execute(intent, execution, controller.signal).catch(async () => {
      try { await this.ports.journal.jobUncertain(intent.operationId, 'Original OCI execution requires reconciliation') } catch { /* Faulted journal already blocks new entry. */ }
    })
    this.tasks.set(intent.operationId, { controller, task })
    return this.ports.journal.jobStatus(intent.operationId)
  }
  private async execute(intent: RemoteJobDispatchIntent, execution: JobExecution, signal: AbortSignal) {
    let outputsRequested = false
    const result = await executeJob(execution, {
      authority: {
        recheck: async () => { await this.ports.authorize(intent, execution, 'start') },
        claim: async (_execution, name) => {
          if (name !== jobSupervisorIdentity(execution)) throw new Error('Wrong OCI supervisor identity')
          await this.ports.authorize(intent, execution, 'start')
          const reservation = await this.ports.journal.jobReserveEntry(intent.operationId)
          return reservation.reserved ? 'launch' : reservation.receipt.stopFence ? 'cancelled' : 'reconcile'
        },
        launched: async (_execution, name, containerId) => {
          if (!containerId || name !== jobSupervisorIdentity(execution)) throw new Error('Positive original OCI container identity required')
          await this.ports.journal.jobAcknowledgeLaunch(intent.operationId, { containerId, supervisorIdentity: name,
            processIdentityDigest: digest({ executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, containerId, supervisorIdentity: name }), startedAt: new Date().toISOString() })
        },
      }, source: this.ports.source, supervisor: this.ports.supervisor, appendLog: async chunk => { await this.ports.journal.jobAppendLog(intent.operationId, chunk); try { await this.flushLogs(intent.operationId) } catch { /* Durable spool remains pending across transport loss. */ } },
      collectOutputs: async () => { outputsRequested = true },
    }, signal)
    if (result.recoveryRequired || !result.processStopped || !result.outcome) { await this.ports.journal.jobUncertain(intent.operationId, 'OCI entry or physical closure remains uncertain'); return }
    const receipt = await this.ports.journal.jobTerminal(intent.operationId, this.terminalEvidence(result, false))
    // A lost main acceptance ACK leaves physical evidence durable and publication pending.
    await this.ports.observeReceipt(receipt)
    const recorded = await this.ports.journal.jobPublication(intent.operationId, 'process_recorded')
    await this.ports.observeReceipt(recorded)
    if (outputsRequested) {
      await this.ports.authorize(intent, execution, 'publish')
      await this.ports.observeReceipt(await this.ports.journal.jobPublication(intent.operationId, 'collecting'))
      try { await this.ports.collectOutputs(execution) }
      catch { await this.ports.observeReceipt(await this.ports.journal.jobPublication(intent.operationId, 'failed')); return }
    }
    await this.ports.observeReceipt(await this.ports.journal.jobPublication(intent.operationId, 'complete'))
  }
  private async flushLogs(operationId: string) {
    for (const chunk of await this.ports.journal.jobPendingLogs(operationId)) {
      await this.ports.appendLog(chunk)
      await this.ports.journal.jobAcknowledgeLog(operationId, chunk.sequence)
    }
  }
  private terminalEvidence(result: JobExecutorResult, logGapPossible: boolean): RemoteJobTerminalEvidence {
    if (!result.outcome || !result.processStopped || result.recoveryRequired) throw new Error('Positive OCI closure required')
    return { finishedAt: new Date().toISOString(), closureEvidenceDigest: digest({ containerId: result.containerId, supervisorIdentity: result.supervisorIdentity,
      processStopped: result.processStopped, exitCode: result.exitCode, signal: result.signal }), outcome: result.outcome, exitCode: result.exitCode, signal: result.signal,
      processStopped: true, resultDigest: digest(result), logGapPossible, logsTruncated: result.logsTruncated, outputCollectionError: result.outputCollectionError, artifactDigests: [] }
  }
  private async reconcile(receipt: RemoteJobOperationReceipt) {
    try { await this.flushLogs(receipt.intent.operationId) } catch { /* Explicit durable pending log cursor remains. */ }
    if (receipt.terminal || this.tasks.has(receipt.intent.operationId) || !receipt.entryAttempted) return this.ports.journal.jobStatus(receipt.intent.operationId)
    await this.ports.authorize(receipt.intent, receipt.execution, 'read')
    const observed = await this.ports.supervisor.reconcile(receipt.execution)
    if (!observed) { await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original OCI supervisor absent: nonexecution not proven'); return this.ports.journal.jobStatus(receipt.intent.operationId) }
    if (receipt.native && receipt.native.containerId !== observed.containerId) throw new Error('Recovered OCI container identity changed')
    if (!receipt.native) await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution), processIdentityDigest: digest({ executionId: receipt.execution.id, attemptId: receipt.execution.attemptId, operationId: receipt.execution.operationId, containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution) }) })
    // Recovered absence of logs is explicit; stopped without exact exit outcome remains uncertain.
    if (!observed.stopped || observed.exitCode === null) return this.ports.journal.jobStatus(receipt.intent.operationId)
    const evidence = this.terminalEvidence({ outcome: observed.exitCode === 0 ? 'succeeded' : 'build_failed', exitCode: observed.exitCode, signal: null, processStopped: true,
      supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId: observed.containerId, recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true)
    await this.ports.observeReceipt(await this.ports.journal.jobTerminal(receipt.intent.operationId, evidence))
    return this.ports.journal.jobStatus(receipt.intent.operationId)
  }
  private async control(command: RemoteJobOwnerControl) {
    const recorded = await this.ports.journal.jobControl(command)
    this.tasks.get(command.operationId)?.controller.abort()
    if (recorded.dispatch) await this.ports.supervisor.stopExecution(recorded.receipt.execution,
      recorded.receipt.execution.acceptedSpec.policy.cancellationGraceMs, recorded.receipt.native?.containerId)
    return this.reconcile(recorded.receipt)
  }
  async drain() { await Promise.all([...this.tasks.values()].map(value => value.task)) }
}
