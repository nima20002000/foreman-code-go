import { resolve } from 'node:path'
import type pg from 'pg'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { DurableInteraction } from '@graphql/contracts'
import { ExecutableWorkflowV3Schema, type WorkflowRunV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import type { GraphResumeClaim } from '../interactions/deliveryPostgres.js'
import { withCleanupDeadline } from '../interactions/cleanup.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { executeRepeatEngineStart } from './repeatStartComposition.js'
import { repeatSettlementPending } from './repeatRuntime.js'
import { readWorkflowCheckpoint } from './repeatGraph.js'
import { persistWorkflowApprovalWait, settleWorkflowRun } from './workflowLifecycle.js'
import { consumeDeliveredApprovals, type WorkflowResumePermit } from './approvalCheckpointResume.js'
import type { AuthorizeWorkflowStop } from './repeatLifecycle.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import type { WorkflowOrchestrator } from './port.js'
import { RunnerAdmission } from './runnerAdmission.js'

/** One engine, Run owner, checkpoint thread and repository for all current V3
 * graphs. Optional bounded blocks are compiled into this same LangGraph; an
 * ordinary graph has no block/round/carry/decision storage. There is no legacy
 * dispatcher, retagging, second scheduler, or caller-supplied runtime binding. */
export class LangGraphWorkflowEngine implements WorkflowOrchestrator {
  private readonly workerAdmission: RunnerAdmission
  private readonly configuredParallelism: number
  private readonly maximumActiveRuns: number
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeTasks = new Map<string, Promise<void>>()
  private readonly resumeTasks = new Map<string, Promise<void>>()
  private readonly cleanupTasks = new Map<string, Promise<boolean>>()
  private readonly workspaceRoot: string
  private closing = false
  private reconciliation: Promise<void> | undefined
  private shutdownTask: Promise<void> | undefined
  private restartClosure: Promise<void> | undefined

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly nativeExecutions: ApprovalExecutionCoordinator,
    private readonly checkpointer: BaseCheckpointSaver,
    workspaceRoot: string,
    private readonly locations: WorkspaceLocationService,
    private readonly workerCredentials: ExecutionCredentialProvider,
    private readonly interactions: PostgresInteractionRepository,
    private readonly onRunTerminal?: (runId: string, reason: string) => Promise<void>,
    limits: { workerParallelism?: number; maximumWaiting?: number; maximumActiveRuns?: number } = {},
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.configuredParallelism = limits.workerParallelism ?? 4
    this.maximumActiveRuns = limits.maximumActiveRuns ?? 32
    this.workerAdmission = new RunnerAdmission(this.configuredParallelism, limits.maximumWaiting ?? 1000, this.maximumActiveRuns)
    this.runs.repeatRepositoryFactory()
    if (!this.interactions || !this.nativeExecutions || !this.checkpointer) throw new DomainError(
      'WORKFLOW_RUNTIME_COMPOSITION_REQUIRED', 'The current production workflow runtime is incomplete.', 503)
  }

  assertCurrentProduction(runs: PostgresRunRepository, workflows: PostgresWorkflowRepository,
    native: ApprovalExecutionCoordinator, checkpointer: BaseCheckpointSaver): void {
    if (this.runs !== runs || this.workflows !== workflows || this.nativeExecutions !== native
      || this.checkpointer !== checkpointer || !this.interactions || !this.workerCredentials) throw new DomainError(
      'CURRENT_ENGINE_COMPOSITION_REQUIRED', 'The current engine must retain the actual native, repository and checkpoint ports.', 503)
    runs.repeatRepositoryFactory()
  }
  acceptsCurrentWork(): boolean { return !this.closing }

  start(runId: string): Promise<void> {
    const existing = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId)
    if (existing) return existing
    return this.trackRun(runId, (controller) => this.drive(runId, controller))
  }

  private trackRun(runId: string, work: (controller: AbortController) => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    if (this.activeTasks.has(runId)) return this.activeTasks.get(runId)!
    if (this.activeTasks.size >= this.maximumActiveRuns) return Promise.reject(new DomainError(
      'RUNNER_ADMISSION_FULL', 'The runner is at its active Run limit. Durable queued work was not launched.', 503))
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    // Publish before dispatch, so Stop can abort even owner acquisition/preflight.
    const task = Promise.resolve().then(() => work(controller)).finally(() => {
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      if (this.activeTasks.get(runId) === task) this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  resume(runId: string): Promise<void> { return this.queueResume(runId) }

  resumeInteraction(interaction: DurableInteraction, claim?: GraphResumeClaim): Promise<void> {
    // Notifications select only; the real current checkpoint is re-read below.
    if (!interaction.runId || interaction.runId !== interaction.graphThreadId) return Promise.reject(new DomainError(
      'INTERACTION_RUN_MISMATCH', 'Resume must name one exact Run checkpoint.', 409))
    return this.queueResume(interaction.runId, [interaction.id], claim)
  }

  private queueResume(runId: string, requestedIds?: readonly string[], claim?: GraphResumeClaim): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    const ids = requestedIds ? [...requestedIds] : undefined
    const previous = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() =>
      this.trackRun(runId, (controller) => this.drive(runId, controller, ids, claim)),
    ).finally(() => { if (this.resumeTasks.get(runId) === task) this.resumeTasks.delete(runId) })
    this.resumeTasks.set(runId, task)
    return task
  }

  private async drive(runId: string, controller: AbortController, requestedIds?: readonly string[],
    claim?: GraphResumeClaim): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => controller.abort(new DomainError(
      'RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409)))
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'This Run is owned by another engine.', 409)
    let runtimeEntered = false
    try {
      owner.assertOwned(); controller.signal.throwIfAborted()
      let snapshot = await this.runs.getRepeatSnapshot(runId, owner)
      if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') {
        await this.cleanupOwned(owner)
        return
      }
      if (!['queued', 'running', 'waiting'].includes(snapshot.run.executionState)) throw new DomainError(
        'RUN_NOT_RESUMABLE', 'This Run requires Stop settlement or a separately authorized new Run.', 409)
      const checkpoint = await readWorkflowCheckpoint(runId, snapshot.version, this.checkpointer)
      if (checkpoint.values.runId && checkpoint.values.runId !== runId) throw new DomainError('RUN_PIN_CONFLICT', 'The checkpoint belongs to another Run.', 409)
      let permit: WorkflowResumePermit | undefined
      if (checkpoint.tasks.some((task) => task.interrupts?.length)) {
        const current = await persistWorkflowApprovalWait(owner, this.checkpointer, checkpoint)
        owner.assertOwned(); controller.signal.throwIfAborted()
        if (requestedIds && !current.some((item) => requestedIds.includes(item.id))) return
        const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
        if (!delivered.length) return
        permit = await consumeDeliveredApprovals(owner, this.checkpointer, this.interactions, delivered, claim,
          (sql, run) => this.authorize(sql, run))
        if (!permit) return
        snapshot = await this.runs.getRepeatSnapshot(runId, owner)
      } else if (snapshot.run.executionState === 'waiting') {
        throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'A waiting Run has no matching durable approval checkpoint.', 409)
      } else if (requestedIds) return
      owner.assertOwned(); controller.signal.throwIfAborted()
      const { run } = snapshot
      runtimeEntered = true
      await executeRepeatEngineStart({ owner, signal: controller.signal,
        checkpointer: this.checkpointer, admission: this.workerAdmission,
        configuredParallelism: this.configuredParallelism, runtimeRoot: this.workspaceRoot,
        factory: this.runs.repeatRepositoryFactory(), native: this.nativeExecutions,
        workflows: this.workflows, locations: this.locations,
        nativeBoundaryEvidence: (id) => this.nativeExecutions.nativeBoundaryEvidence(id, owner),
        lifecycle: {
          preflight: async () => {
            owner.assertOwned(); controller.signal.throwIfAborted()
            const current = await this.runs.getRepeatSnapshot(runId, owner)
            ExecutableWorkflowV3Schema.parse({ version: current.version, configurations: current.configurations })
            for (const configuration of current.configurations) assertNativeWorkflowConfiguration(configuration.harness, run.approval,
              run.approval.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
            await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
            await this.locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess(current.configurations), controller.signal)
            owner.assertOwned(); controller.signal.throwIfAborted()
          },
          markRunning: () => this.runs.updateState(runId, { executionState: 'running', outcome: 'pending',
            startedAt: run.startedAt ?? new Date().toISOString() }, owner, permit),
          currentState: async () => {
            const current = await this.runs.getRepeatSnapshot(runId, owner)
            return { executionState: current.run.executionState, stopRequested: current.stopRequested }
          },
          persistWait: async (current) => (await persistWorkflowApprovalWait(owner, this.checkpointer, current)).length > 0,
          cancelNativeAndRequestCleanup: async () => {
            await this.runs.requestCleanup(runId, owner)
            try { await this.nativeExecutions.cancelRun(runId, owner); return true } catch { return false }
          },
          settleRun: async () => { await this.cleanupOwned(owner) },
          requestCleanup: () => this.runs.requestCleanup(runId, owner),
          finishNative: () => this.nativeExecutions.finishRun(runId),
          finishCleanup: () => this.runs.finishCleanup(runId, false, owner),
        },
      })
      if ((await this.runs.getRepeatSnapshot(runId, owner)).run.executionState === 'completed') await this.finishOwned(owner)
    } catch (error) {
      owner.assertOwned(); controller.signal.throwIfAborted()
      // Only an entered runtime may yield settlement to existing recovery. In
      // particular, NEVER turn a pre-consume/claim/COMMIT failure into a void
      // successful resume callback (which would have no graph.resume receipt).
      if (!runtimeEntered || !repeatSettlementPending(error)) throw error
      const current = await this.runs.getRepeatSnapshot(runId, owner)
      if (current.stopRequested || current.cleanupPending
        || !['running', 'waiting'].includes(current.run.executionState)) throw error
      // The exact task/error and native lifetime remain durable/resident. A
      // consumed approval is not callback failure merely because cleanup or a
      // sibling reviewer still needs to finish; reconcile() retries this thread.
    } finally {
      // Wait only for captured native closure, never shutdownTask (which drains
      // this drive). A rejected closure is explicit uncertainty reported by
      // shutdown; release still drains G1 writes without rewriting Run history.
      await this.restartClosure?.catch(() => undefined)
      // Drains in-flight G1 writes. Old captures cannot write after release.
      await owner.release()
    }
  }

  private authorize(sql: import('../run-graph/connection.js').GraphTransactionSql, run: WorkflowRunV3): Promise<void> {
    if (!run.authorizationPrincipalId) throw new DomainError('RUN_AUTHORIZATION_REVOKED', 'The accepted Run authority is missing.', 403)
    return this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId,
      sql as unknown as Pick<pg.PoolClient, 'query'>)
  }

  private async cleanupOwned(owner: RunOwnership): Promise<void> {
    owner.assertOwned()
    const snapshot = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') throw new DomainError(
      'GRAPH_STOP_CONFLICT', 'Cleanup requires the committed negative or terminal fence.', 409)
    await this.runs.requestCleanup(owner.runId, owner)
    try {
      if (snapshot.run.executionState !== 'completed' || snapshot.stopRequested || snapshot.run.outcome !== 'succeeded') {
        await this.nativeExecutions.cancelRun(owner.runId, owner)
        await settleWorkflowRun(owner, false)
      } else await this.nativeExecutions.finishRun(owner.runId)
      await this.finishOwned(owner)
    } catch (error) {
      await this.runs.finishCleanup(owner.runId, true, owner).catch(() => undefined)
      throw error
    }
  }

  private async finishOwned(owner: RunOwnership, reason = 'The Run stopped or completed.'): Promise<void> {
    const current = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (current.run.executionState !== 'completed') throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'The Run has not settled.', 409)
    await this.nativeExecutions.finishRun(owner.runId)
    await this.onRunTerminal?.(owner.runId, reason)
    await this.runs.finishCleanup(owner.runId, false, owner)
  }

  async finishRunLifecycle(runId: string, reason = 'The Run stopped or completed.'): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => undefined)
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'The existing Run owner must finish cleanup.', 409)
    try { await this.finishOwned(owner, reason) } finally { await owner.release() }
  }

  /** Supply the SQL Stop authorizer or ALREADY commit the authorized Stop/cleanup
   * intent. A cleanup callback return never substitutes for settlement proof. */
  async cancel(runId: string, authorize?: AuthorizeWorkflowStop): Promise<boolean> {
    if (authorize) await this.runs.requestStop(runId, authorize)
    const initial = await this.runs.getRepeatSnapshot(runId)
    if (!initial.stopRequested && !initial.cleanupPending && initial.run.executionState !== 'completed') throw new DomainError(
      'REPEAT_STOP_AUTHORIZATION_REQUIRED', 'Commit the authorized Stop before native cancellation.', 409)
    const existing = this.cleanupTasks.get(runId)
    if (existing) return existing
    this.activeRuns.get(runId)?.abort(new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a durable Stop or cleanup request.', 409))
    const task = (async () => {
      const physical = initial.run.executionState === 'completed' && initial.run.outcome === 'succeeded'
        && !initial.stopRequested ? this.nativeExecutions.finishRun(runId) : this.nativeExecutions.cancelRun(runId)
      await Promise.allSettled([physical, ...(this.activeTasks.has(runId) ? [this.activeTasks.get(runId)!] : [])])
      const owner = await this.runs.acquireOwnership(runId, () => undefined)
      if (!owner) return false
      try {
        await this.cleanupOwned(owner)
        const final = await this.runs.getRepeatSnapshot(runId, owner)
        return final.run.executionState === 'completed' && !final.cleanupPending
      } finally { await owner.release() }
    })().finally(() => { if (this.cleanupTasks.get(runId) === task) this.cleanupTasks.delete(runId) })
    this.cleanupTasks.set(runId, task)
    return task
  }

  /** Bounded current recovery. Never reset an existing checkpoint to initial state. */
  reconcile(onError: (error: unknown) => void = console.error): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const task = (async () => {
      await this.workerCredentials.reconcileTerminalCredentials?.().catch(onError)
      await this.nativeExecutions.reconcileReviews(onError)
      let after = ''
      while (!this.closing) {
        const page = await this.runs.reconciliationCandidates(after, 100)
        if (!page.length) break
        for (const candidate of page) {
          after = candidate.id
          if (this.closing) break
          if (this.activeTasks.has(candidate.id) || this.resumeTasks.has(candidate.id) || this.cleanupTasks.has(candidate.id)) continue
          if (this.activeTasks.size >= this.maximumActiveRuns) break
          void this.start(candidate.id).catch(onError)
        }
        if (page.length < 100 || this.activeTasks.size >= this.maximumActiveRuns) break
      }
    })().finally(() => { if (this.reconciliation === task) this.reconciliation = undefined })
    this.reconciliation = task
    return task
  }

  /** Graceful restart is NOT Stop. Original transport close receipts precede
   * ownership release. Unknown closure fails shutdown, not the Run's history. */
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closing = true
    this.restartClosure = this.nativeExecutions.closeForRestart()
    const reason = new DomainError('ENGINE_RESTART', 'The engine is preserving the current checkpoint for restart.', 409)
    for (const controller of this.activeRuns.values()) controller.abort(reason)
    this.shutdownTask = (async () => {
      const outcomes = await Promise.allSettled([
        this.restartClosure,
        withCleanupDeadline(async () => { await Promise.allSettled([...this.activeTasks.values(), ...this.resumeTasks.values()]) }),
        ...this.cleanupTasks.values(),
      ])
      const errors = outcomes.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Workflow restart closure or task draining remains unconfirmed.')
    })()
    return this.shutdownTask
  }
}
