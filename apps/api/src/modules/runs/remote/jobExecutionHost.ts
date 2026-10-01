import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { JobExecutionSchema, type JobExecution } from '@graphql/contracts/jobs'
import { canonicalGraphJson } from '@graphql/contracts/wave25'
import { RemoteJobExecutionRpcRequestSchema, type RemoteJobDispatchIntent, type RemoteJobConnectionIdentity,
  type RemoteJobOwnerControl, type RemoteJobOperationReceipt, type RemoteJobTerminalEvidence } from '@graphql/contracts/remote-job-execution'
import { JobOutputCollectionError } from '../../jobs/executorOutputs.js'
import { executeJob, jobSupervisorIdentity, type JobExecutorPorts, type JobExecutorResult } from '../../jobs/executor.js'
import type { PodmanJobSupervisor } from '../../jobs/executorPodman.js'
import type { RemoteOperationJournal } from './operationJournal.js'

const digest = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
export interface RemoteJobExecutionHostPorts {
  journal: RemoteOperationJournal
  connection: RemoteJobConnectionIdentity
  incarnationId: string
  supervisor: PodmanJobSupervisor | ((execution: JobExecution) => Promise<PodmanJobSupervisor>)
  source: JobExecutorPorts['source']
  /** Mandatory W09 canonical delivery; exact tuple is verified before claim/native entry. */
  inputs: JobExecutorPorts['inputs']
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
  /** Worker startup rearms only the original local watchdogs, without Main IO or relaunch. */
  async recover(): Promise<void> {
    for (const receipt of await this.ports.journal.jobOperations()) {
      if (!receipt.entryAttempted || receipt.terminal) continue
      this.validate(receipt.intent, receipt.execution)
      const observed = await (await this.supervisor(receipt.execution)).reconcile(receipt.execution)
      if (!observed) await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original OCI supervisor absent during worker recovery')
    }
  }
  async shutdown(): Promise<void> {
    const active = [...this.tasks.entries()]
    for (const [, owned] of active) owned.controller.abort(new Error('Worker job host is shutting down.'))
    await Promise.all(active.map(([, owned]) => owned.task))
    for (const receipt of await this.ports.journal.jobOperations()) {
      if (!receipt.entryAttempted || receipt.terminal) continue
      const supervisor = await this.supervisor(receipt.execution)
      let observed = await supervisor.reconcile(receipt.execution)
      const interrupted = observed && !observed.stopped
      if (interrupted) {
        if (!await supervisor.stopExecution(receipt.execution, receipt.execution.acceptedSpec.policy.cancellationGraceMs, observed!.containerId)) throw new Error('Original Job shutdown closure remains unconfirmed')
        observed = await supervisor.reconcile(receipt.execution)
      }
      if (!observed?.stopped || observed.exitCode === null) throw new Error('Original Job shutdown closure remains unconfirmed')
      if (!receipt.native) await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId: observed.containerId,
        supervisorIdentity: jobSupervisorIdentity(receipt.execution), processIdentityDigest: digest({ executionId: receipt.execution.id,
          attemptId: receipt.execution.attemptId, operationId: receipt.execution.operationId, containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution) }) })
      await this.ports.journal.jobTerminal(receipt.intent.operationId, this.terminalEvidence({ outcome: interrupted || receipt.stopFence ? 'cancelled' :
        observed.timedOut ? 'timed_out' : observed.execError ? 'spawn_failed' : observed.exitCode === 0 ? 'succeeded' : 'build_failed', exitCode: observed.exitCode,
        signal: null, processStopped: true, supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId: observed.containerId,
        recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true))
    }
  }
  async handle(raw: unknown) {
    const frame = RemoteJobExecutionRpcRequestSchema.parse(raw)
    if (frame.method === 'job-dispatch') return this.deliver(frame.intent, frame.execution)
    const status = await this.ports.journal.jobStatus(frame.intent.operationId)
    if (status.status !== 'known') return status
    if (!isDeepStrictEqual(status.receipt.intent, frame.intent)) throw new Error('Stale job RPC owner')
    this.validate(frame.intent, status.receipt.execution)
    await this.ports.authorize(frame.intent, status.receipt.execution, frame.method === 'job-control' ? 'control' : 'read')
    if (frame.method === 'job-control') {
      if (frame.command.operationId !== frame.intent.operationId || frame.command.executionId !== frame.intent.executionId ||
        frame.command.attemptId !== frame.intent.attemptId || frame.command.bindingHash !== frame.intent.bindingHash ||
        !isDeepStrictEqual(frame.command.subject, frame.intent.subject) || !isDeepStrictEqual(frame.command.owner, frame.intent.owner)) throw new Error('Job control envelope ownership mismatch')
      return this.control(frame.command)
    }
    return this.reconcile(status.receipt)
  }
  async deliver(intent: RemoteJobDispatchIntent, raw: JobExecution) {
    const execution = JobExecutionSchema.parse(raw)
    this.validate(intent, execution)
    await this.ports.authorize(intent, execution, 'start')
    await this.ports.journal.jobAccept(intent, execution, this.ports.connection, this.ports.incarnationId)
    const status = await this.ports.journal.jobStatus(intent.operationId)
    if (status.status !== 'known') return status
    if (this.tasks.has(intent.operationId)) return status
    if (status.receipt.phase !== 'received') return this.reconcile(status.receipt)
    const controller = new AbortController()
    const task = this.execute(intent, execution, controller.signal).catch(async () => {
      try { await this.ports.journal.jobUncertain(intent.operationId, 'Original OCI execution requires reconciliation') } catch { /* Faulted journal already blocks new entry. */ }
    })
    this.tasks.set(intent.operationId, { controller, task })
    void task.finally(() => { if (this.tasks.get(intent.operationId)?.task === task) this.tasks.delete(intent.operationId) }).catch(() => {})
    return this.ports.journal.jobStatus(intent.operationId)
  }
  private async execute(intent: RemoteJobDispatchIntent, execution: JobExecution, signal: AbortSignal) {
    const supervisor = await this.supervisor(execution)
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
      }, source: this.ports.source, inputs: this.ports.inputs, supervisor, appendLog: async chunk => { await this.ports.journal.jobAppendLog(intent.operationId, chunk); try { await this.flushLogs(intent.operationId) } catch { /* Durable spool remains pending across transport loss. */ } },
      collectOutputs: async () => {},
    }, signal)
    if (result.recoveryRequired || !result.processStopped || !result.outcome) { await this.ports.journal.jobUncertain(intent.operationId, 'OCI entry or physical closure remains uncertain'); return }
    const receipt = await this.ports.journal.jobTerminal(intent.operationId, this.terminalEvidence(result, false))
    await this.publish(receipt)
  }
  private supervisor(execution: JobExecution) {
    return typeof this.ports.supervisor === 'function' ? this.ports.supervisor(execution) : Promise.resolve(this.ports.supervisor)
  }
  /** Each transition is fsynced before transport IO. Lost ACKs resume the same output commands. */
  private async publish(original: RemoteJobOperationReceipt) {
    let receipt = original
    await this.ports.observeReceipt(receipt)
    if (receipt.publication === 'complete' || receipt.publication === 'failed') return
    if (receipt.publication === 'pending') {
      receipt = await this.ports.journal.jobPublication(receipt.intent.operationId, 'process_recorded')
      await this.ports.observeReceipt(receipt)
    }
    if (receipt.entryAttempted && receipt.native) {
      try { await this.ports.authorize(receipt.intent, receipt.execution, 'publish') }
      catch { await this.ports.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'failed')); return }
      if (receipt.publication !== 'collecting') receipt = await this.ports.journal.jobPublication(receipt.intent.operationId, 'collecting')
      await this.ports.observeReceipt(receipt)
      // A collector may have published before losing its ACK. Keep collecting; W09's
      // retained command IDs reconcile publication instead of allocating another revision.
      try { await this.ports.collectOutputs(receipt.execution) } catch (error) {
        if (!(error instanceof JobOutputCollectionError)) throw error
        await this.ports.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'failed')); return
      }
    }
    await this.ports.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'complete'))
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
    if (this.tasks.has(receipt.intent.operationId)) return this.ports.journal.jobStatus(receipt.intent.operationId)
    if (receipt.terminal) { await this.publish(receipt); return this.ports.journal.jobStatus(receipt.intent.operationId) }
    if (!receipt.entryAttempted) {
      if (receipt.stopFence) await this.publish(await this.ports.journal.jobTerminal(receipt.intent.operationId, this.terminalEvidence({
        outcome: 'cancelled', exitCode: null, signal: null, processStopped: true, supervisorIdentity: jobSupervisorIdentity(receipt.execution),
        containerId: null, recoveryRequired: false, logError: false, logsTruncated: false, outputCollectionError: false }, false)))
      return this.ports.journal.jobStatus(receipt.intent.operationId)
    }
    await this.ports.authorize(receipt.intent, receipt.execution, 'read')
    const supervisor = await this.supervisor(receipt.execution)
    const observed = await supervisor.reconcile(receipt.execution)
    if (!observed) { await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original OCI supervisor absent: nonexecution not proven'); return this.ports.journal.jobStatus(receipt.intent.operationId) }
    if (receipt.native && receipt.native.containerId !== observed.containerId) throw new Error('Recovered OCI container identity changed')
    if (!receipt.native) await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution), processIdentityDigest: digest({ executionId: receipt.execution.id, attemptId: receipt.execution.attemptId, operationId: receipt.execution.operationId, containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution) }) })
    // Recovered absence of logs is explicit; stopped without exact exit outcome remains uncertain.
    if (!observed.stopped || observed.exitCode === null) return this.ports.journal.jobStatus(receipt.intent.operationId)
    const evidence = this.terminalEvidence({ outcome: receipt.stopFence ? 'cancelled' : observed.timedOut ? 'timed_out' : observed.execError ? 'spawn_failed' : observed.exitCode === 0 ? 'succeeded' : 'build_failed', exitCode: observed.exitCode, signal: null, processStopped: true,
      supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId: observed.containerId, recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true)
    await this.publish(await this.ports.journal.jobTerminal(receipt.intent.operationId, evidence))
    return this.ports.journal.jobStatus(receipt.intent.operationId)
  }
  private async control(command: RemoteJobOwnerControl) {
    const recorded = await this.ports.journal.jobControl(command)
    this.tasks.get(command.operationId)?.controller.abort()
    if (recorded.dispatch) await (await this.supervisor(recorded.receipt.execution)).stopExecution(recorded.receipt.execution,
      recorded.receipt.execution.acceptedSpec.policy.cancellationGraceMs, recorded.receipt.native?.containerId)
    return this.reconcile(recorded.receipt)
  }
  async drain() { await Promise.all([...this.tasks.values()].map(value => value.task)) }
}
