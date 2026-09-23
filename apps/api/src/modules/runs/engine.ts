import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Annotation, Command, END, START, StateGraph, interrupt, isGraphInterrupt } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type pg from 'pg'
import {
  HarnessExecutionRequestSchema,
  HarnessExecutionSchema,
  type ExecutionResult,
  type WorkflowRun,
  type WorkflowVersion,
  type DurableInteraction,
} from '@graphql/contracts'

import { WorkflowVersionV2Schema } from '@graphql/contracts/wave25'
import { executeOneShotRuntime } from './oneShotRuntime.js'
import { consumeDeliveredApprovals } from './approvalCheckpointResume.js'
import type { GraphResumeClaim } from '../interactions/deliveryPostgres.js'
import { compileOneShotGraph } from './oneShotGraph.js'
import { compileOneShotTopology } from './topology.js'
import { RunnerAdmission } from './runnerAdmission.js'

import { DomainError } from '../errors.js'
import { validateWorkflowApproval } from '../workflows/approval.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import type { WorkflowOrchestrator } from './port.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import { ExecutionLimiter } from './limiter.js'
import { validateExecutableTopology } from './topology.js'
import { resolveExecutionDirectory } from './executionDirectory.js'
import { withCleanupDeadline } from '../interactions/cleanup.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'

const EngineState = Annotation.Root({
  runId: Annotation<string>(),
  executionIds: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
})
type EngineStateValue = typeof EngineState.State

interface GraphSnapshot {
  values: Partial<EngineStateValue>
  next: string[]
  tasks: Array<{
    name: string
    error?: unknown
    result?: unknown
    interrupts?: Array<{ id: string; value: unknown }>
  }>
}

interface DynamicCompiledGraph {
  invoke(
    input: EngineStateValue | Command,
    config: { configurable: { thread_id: string }; signal?: AbortSignal },
  ): Promise<EngineStateValue>
  getState(config: { configurable: { thread_id: string } }): Promise<GraphSnapshot>
}

interface DynamicGraphBuilder {
  addNode(name: string, action: (state: EngineStateValue) => Promise<Partial<EngineStateValue>>): DynamicGraphBuilder
  addEdge(source: string | string[], target: string): DynamicGraphBuilder
  compile(options: { checkpointer: BaseCheckpointSaver }): DynamicCompiledGraph
}

function failedResult(error: unknown, canceled: boolean): ExecutionResult {
  if (canceled) return { outcome: 'canceled' }
  if (error instanceof HarnessExecutionError) return error.result
  return {
    outcome: 'failed',
    error: {
      code: error instanceof DomainError ? error.code : 'WORKFLOW_EXECUTION_FAILED',
      message: error instanceof Error ? error.message : 'Unknown workflow execution failure.',
      retryable: false,
    },
  }
}

function cleanupFailedResult(): ExecutionResult {
  return {
    outcome: 'failed',
    error: { code: 'RUN_CLEANUP_FAILED', message: 'Run cleanup was incomplete. Native work may remain active; retry Stop to finish cleanup.', retryable: false },
  }
}

/** Observe graph cancellation even when a native iterator ignores its signal. */
async function withExecutionSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function isOneShotRun(run: WorkflowRun): boolean {
  return 'executionSemanticsVersion' in run && run.executionSemanticsVersion === 2
}

export class LangGraphWorkflowEngine implements WorkflowOrchestrator {
  private readonly workerAdmission: RunnerAdmission
  private readonly configuredParallelism: number
  private readonly maximumActiveRuns: number
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeTasks = new Map<string, Promise<void>>()
  private readonly resumeTasks = new Map<string, Promise<void>>()
  private readonly workspaceRoot: string
  private closing = false
  private reconciliation: Promise<void> | undefined

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly nativeExecutions: ApprovalExecutionCoordinator,
    private readonly checkpointer: BaseCheckpointSaver,
    workspaceRoot: string,
    private readonly locations: WorkspaceLocationService,
    private readonly workerCredentials?: ExecutionCredentialProvider,
    private readonly interactions?: PostgresInteractionRepository,
    private readonly onRunTerminal?: (runId: string, reason: string) => Promise<void>,
    limits: { workerParallelism?: number; maximumWaiting?: number; maximumActiveRuns?: number } = {},
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.configuredParallelism = limits.workerParallelism ?? 4
    this.maximumActiveRuns = limits.maximumActiveRuns ?? 32
    this.workerAdmission = new RunnerAdmission(this.configuredParallelism, limits.maximumWaiting ?? 1000, this.maximumActiveRuns)
  }

  start(runId: string): Promise<void> {
    const existing = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId)
    if (existing) return existing
    return this.trackRun(runId, (controller) => this.startRun(runId, controller))
  }

  private trackRun(runId: string, work: (controller: AbortController) => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    if (this.activeTasks.size >= this.maximumActiveRuns) return Promise.reject(new DomainError(
      'RUNNER_ADMISSION_FULL', 'The runner is at its active Run limit. Durable queued work was not launched.', 503))
    // Register cancellation before the first database await, including queued work.
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const task = work(controller).then(async () => {
      if ((await this.runs.get(runId))?.executionState === 'completed') {
        await this.finishRunLifecycle(runId)
      }
    }).finally(() => {
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      if (this.activeTasks.get(runId) === task) this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  private async startRun(runId: string, controller: AbortController): Promise<void> {
    let owner: RunOwnership | undefined
    try {
      owner = await this.runs.acquireOwnership(runId, () => controller.abort(
        new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409),
      ))
      if (!owner) throw new DomainError('RUN_ALREADY_OWNED', `Run '${runId}' is owned by another engine.`, 409)
      const run = await this.runs.get(runId, owner)
      if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
      if (run.executionState !== 'queued') {
        throw new DomainError('RUN_NOT_STARTABLE', `Run '${runId}' is not queued.`, 409)
      }
      if (controller.signal.aborted) {
        const cleanupFailure = await this.cleanupApprovals(runId)
        await this.settleCanceled(runId, owner, cleanupFailure)
        return
      }
      await this.executeRun(run, controller.signal, owner)
    } finally {
      await owner?.release()
    }
  }

  /** Recover queued work; do not replay interrupted native side effects. */
  reconcile(onError: (error: unknown) => void = console.error): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const task = (async () => {
      await this.workerCredentials?.reconcileTerminalCredentials?.().catch(onError)
      await this.nativeExecutions.reconcileReviews(onError)
      for (const candidate of await this.runs.reconciliationCandidates()) {
        if (this.closing) break
        if (this.activeTasks.has(candidate.id) || this.resumeTasks.has(candidate.id)) continue
        if (await this.runs.hasPendingCleanup?.(candidate.id)) {
          await this.cancel(candidate.id, undefined, false).catch(onError)
          if ((await this.runs.get(candidate.id))?.executionState === 'completed') {
            await this.finishRunLifecycle(candidate.id).catch(onError)
          }
          continue
        }
        if (candidate.executionState === 'queued') {
          void this.start(candidate.id).catch(onError)
          continue
        }
        await this.trackRun(candidate.id, (controller) => this.reconcileRun(candidate.id, controller)).catch(onError)
      }
    })().finally(() => { this.reconciliation = undefined })
    this.reconciliation = task
    return task
  }

  private async reconcileRun(runId: string, controller: AbortController): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => controller.abort(
      new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409),
    ))
    if (!owner) return
    try {
      // Candidate records can be stale by the time database ownership is acquired.
      const run = await this.runs.get(runId, owner)
      if (!run || (run.executionState !== 'running' && run.executionState !== 'waiting')) return
      controller.signal.throwIfAborted()
      {
        const { version, snapshot } = await this.readCheckpoint(run)
        if (this.isApprovalWait(snapshot)) {
          if (!run.approval) throw new DomainError('WORKFLOW_APPROVAL_INCOMPLETE', 'The saved approval wait has no accepted workflow handler. Reopen and save the workflow before starting a new Run.', 409)
          const current = await this.currentInteractions(run, snapshot, owner)
          controller.signal.throwIfAborted()
          if (run.executionState !== 'waiting') {
            await this.runs.updateState(run.id, { executionState: 'waiting', outcome: 'pending' }, owner)
          }
          const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
          if (delivered.length) await this.resumeCheckpoint(run, delivered, controller, owner)
          else await this.resumeTerminalRecoveries(run, current, controller, owner)
          return
        }
        if (this.isTerminalCheckpoint(run, snapshot)) {
          await this.completeRun(run, version, snapshot.values as EngineStateValue, controller.signal, owner)
          return
        }
      }
      if (isOneShotRun(run)) {
        // Re-enter the same thread using durable admitted/result records. The v2
        // driver reconciles a claimed submission; it never blindly relaunches it.
        await this.executeRun(run, controller.signal, owner)
        return
      }
      // No healthy interrupt or terminal checkpoint: never replay orphaned work.
      await this.nativeExecutions.cancelRun(runId)
      await this.runs.settleOrphan(runId, owner, false)
      await this.workerCredentials?.revokeForRun?.(runId)
    } finally {
      try {
        if (controller.signal.aborted) await this.settleCanceledRun(runId, owner)
      } finally { await owner.release() }
    }
  }

  async resume(runId: string): Promise<void> {
    await this.queueResume(runId)
  }

  /** Runs terminal review cleanup only after Run ownership/command transactions are released. */
  async finishRunLifecycle(runId: string, reason = 'The Run stopped or completed.'): Promise<void> {
    if (!this.onRunTerminal) return
    await this.runs.requestCleanup(runId)
    try {
      await this.onRunTerminal(runId, reason)
      await this.runs.finishCleanup(runId, false)
    } catch (error) {
      await this.runs.finishCleanup(runId, true).catch(() => undefined)
      throw error
    }
  }

  async resumeInteraction(interaction: DurableInteraction, claim?: GraphResumeClaim): Promise<void> {
    await this.resumeInteractions([interaction], claim)
  }

  private async resumeInteractions(interactions: DurableInteraction[], claim?: GraphResumeClaim): Promise<void> {
    const runId = interactions[0]?.runId
    if (!runId || interactions.some((item) => item.runId !== runId)) throw new DomainError('INTERACTION_RUN_MISMATCH', 'Resume interactions must belong to one Run.', 409)
    await this.queueResume(runId, interactions.map((item) => item.id), claim)
  }

  private queueResume(runId: string, requestedIds?: string[], claim?: GraphResumeClaim): Promise<void> {
    if (!this.interactions) return Promise.reject(new DomainError('RUN_RESUME_NOT_IMPLEMENTED', `Run '${runId}' has no durable approval runtime.`, 501))
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    // Publish the queue tail synchronously. Waiting callers must not all replace
    // the same active task/controller after a shared predecessor settles.
    const previous = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() =>
      this.trackRun(runId, (controller) => this.resumeRun(runId, controller, requestedIds, claim)),
    ).finally(() => {
      if (this.resumeTasks.get(runId) === task) this.resumeTasks.delete(runId)
    })
    this.resumeTasks.set(runId, task)
    return task
  }

  private async resumeRun(runId: string, controller: AbortController, requestedIds?: string[], claim?: GraphResumeClaim): Promise<void> {
    let owner: RunOwnership | undefined
    try {
      owner = await this.runs.acquireOwnership(runId, () => controller.abort(
        new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409),
      ))
      if (!owner) throw new DomainError('RUN_ALREADY_OWNED', `Run '${runId}' is owned by another engine.`, 409)
      const run = await this.runs.get(runId, owner)
      if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
      // A preceding queued resume may already have consumed this notification.
      if (run.executionState === 'completed' && requestedIds) return
      if (!run.approval || (run.executionState !== 'waiting' && run.executionState !== 'running')) throw new DomainError('RUN_NOT_RESUMABLE', `Run '${runId}' is not waiting.`, 409)
      controller.signal.throwIfAborted()
      const { version, snapshot } = await this.readCheckpoint(run)
      if (this.isTerminalCheckpoint(run, snapshot)) {
        await this.completeRun(run, version, snapshot.values as EngineStateValue, controller.signal, owner)
        return
      }
      if (!this.isApprovalWait(snapshot)) throw new DomainError('RUN_NOT_RESUMABLE', 'The Run has no healthy approval checkpoint.', 409)
      const current = await this.currentInteractions(run, snapshot, owner)
      controller.signal.throwIfAborted()
      if (requestedIds && !current.some((item) => requestedIds.includes(item.id))) return
      // Resolve by CURRENT checkpoint IDs, not a page of historical interactions.
      // Include every delivered branch in one map; leave undecided branches alone.
      const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
      if (!delivered.length) {
        if (await this.resumeTerminalRecoveries(run, current, controller, owner)) return
        throw new DomainError('RUN_NOT_RESUMABLE', `Run '${runId}' has no confirmed delivery or exact terminal execution.`, 409)
      }
      await this.resumeCheckpoint(run, delivered, controller, owner, claim)
    } finally {
      try {
        if (owner && controller.signal.aborted) await this.settleCanceledRun(runId, owner)
      } finally { await owner?.release() }
    }
  }

  private async resumeTerminalRecoveries(run: WorkflowRun, interactions: DurableInteraction[], controller: AbortController, owner: RunOwnership): Promise<boolean> {
    if (!this.nativeExecutions.recoverTerminalInteraction) return false
    const resumes: Record<string, { terminalExecutionId: string }> = {}
    const failures: unknown[] = []
    for (const interaction of interactions) {
      if (!interaction.graphInterruptId || resumes[interaction.graphInterruptId]) continue
      try {
        if (await this.nativeExecutions.recoverTerminalInteraction(interaction, owner, controller.signal)) {
          resumes[interaction.graphInterruptId] = { terminalExecutionId: interaction.executionId }
        }
      } catch (error) {
        controller.signal.throwIfAborted()
        owner.assertOwned()
        failures.push(error)
      }
    }
    if (!Object.keys(resumes).length) {
      if (failures.length) throw new AggregateError(failures, 'Terminal execution recovery remains unconfirmed.')
      return false
    }
    // ensureObserve() returns the durable terminal execution before any interrupt
    // response is consumed. This marker is NOT accepted by assertResume() and
    // cannot serve as an approval for a later/different native request.
    // V2 terminal recovery skips the interrupt only because the exact durable
    // execution is already terminal. It must not inject an unreceipted approval.
    await this.executeRun(run, controller.signal, owner, isOneShotRun(run) ? undefined : new Command({ resume: resumes }))
    return true
  }

  private async resumeCheckpoint(run: WorkflowRun, interactions: DurableInteraction[], controller: AbortController,
    owner: RunOwnership, claim?: GraphResumeClaim): Promise<void> {
    if (isOneShotRun(run)) {
      controller.signal.throwIfAborted()
      if (!await consumeDeliveredApprovals(owner, this.checkpointer, this.interactions, interactions, claim, async (sql, current) => {
        if (current.authorizationPrincipalId) await this.locations.revalidateRunAuthorization(
          current.authorizationPrincipalId, current.workspaceId, current.workflowId,
          sql as unknown as Pick<pg.PoolClient, 'query'>)
      })) return
      // No provider, filesystem operation or graph invocation is inside SQL.
      // A crash here leaves durable task-local resume writes plus the receipt;
      // the same recovery path re-enters without adding another resume value.
      controller.signal.throwIfAborted()
      owner.assertOwned()
      await this.executeRun(run, controller.signal, owner)
      return
    }
    const resumeMap = Object.fromEntries(interactions.map((item) => [item.graphInterruptId!, { interactionId: item.id }]))
    // Approval time is persisted per execution. Each ensure/observe lifetime
    // owns its deadline; completed branches cannot constrain later graph work.
    await this.executeRun(run, controller.signal, owner, new Command({ resume: resumeMap }))
  }

  private buildGraph(version: WorkflowVersion, action: (nodeId: string, state: EngineStateValue) => Promise<Partial<EngineStateValue>>): DynamicCompiledGraph {
    if ('executionSemanticsVersion' in version && version.executionSemanticsVersion === 2) {
      const pinned = WorkflowVersionV2Schema.parse(version)
      const compiled = compileOneShotGraph(pinned, this.checkpointer, action)
      return { getState: (config) => compiled.getState(config),
        invoke: (value, config) => compiled.invoke(value, { ...config, recursionLimit: compileOneShotTopology(pinned).recursionLimit }) }
    }
    const topology = validateExecutableTopology(version)
    const builder = new StateGraph(EngineState) as unknown as DynamicGraphBuilder
    for (const node of version.definition.nodes) builder.addNode(node.id, (state) => action(node.id, state))
    builder.addEdge(START, version.entryNodeId)
    for (const node of version.definition.nodes) {
      const sources = topology.incoming.get(node.id) ?? []
      if (sources.length === 1) builder.addEdge(sources[0] as string, node.id)
      if (sources.length > 1) builder.addEdge(sources, node.id)
    }
    for (const sink of topology.sinks) builder.addEdge(sink, END)
    return builder.compile({ checkpointer: this.checkpointer })
  }

  private async readCheckpoint(run: WorkflowRun): Promise<{ version: WorkflowVersion; snapshot: GraphSnapshot }> {
    const version = isOneShotRun(run) ? await this.runs.getOneShotVersion(run.workflowVersionId)
      : await this.workflows.getVersion(run.workflowVersionId)
    if (!version) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', `Workflow version '${run.workflowVersionId}' was not found.`, 409)
    // getState reads the existing thread without invoking any node, including
    // predecessors. Keep a read-only graph incapable of launching native work.
    const graph = this.buildGraph(version, async () => { throw new Error('Checkpoint inspection cannot execute nodes.') })
    return { version, snapshot: await graph.getState({ configurable: { thread_id: run.id } }) }
  }

  private isApprovalWait(snapshot: GraphSnapshot): boolean {
    return snapshot.tasks.some((task) => task.interrupts?.length)
      && snapshot.tasks.every((task) => task.error == null && (task.interrupts?.length || task.result !== undefined))
  }

  private isTerminalCheckpoint(run: WorkflowRun, snapshot: GraphSnapshot): boolean {
    return snapshot.values.runId === run.id && !!snapshot.values.executionIds
      && snapshot.next.length === 0 && snapshot.tasks.length === 0
  }

  private async currentInteractions(run: WorkflowRun, snapshot: GraphSnapshot, owner: RunOwnership): Promise<DurableInteraction[]> {
    if (!this.interactions) throw new DomainError('APPROVAL_RUNTIME_MISSING', 'The graph interrupted without an interaction repository.', 500)
    const current: DurableInteraction[] = []
    for (const pending of snapshot.tasks.flatMap((task) => task.interrupts ?? [])) {
      const value = pending.value as { interactionId?: unknown; interactionIds?: unknown }
      if (!pending.id || typeof value?.interactionId !== 'string') throw new DomainError('GRAPH_INTERRUPT_INVALID', 'The graph interrupt has no interaction identity.', 500)
      const ids = value.interactionIds ?? [value.interactionId]
      if (!Array.isArray(ids) || !ids.includes(value.interactionId) || ids.some((id) => typeof id !== 'string')
        || new Set(ids).size !== ids.length) throw new DomainError('GRAPH_INTERRUPT_INVALID', 'The graph interrupt has invalid interaction identities.', 500)
      for (const id of ids) {
      const item = await this.interactions.get(id)
      if (!item || item.runId !== run.id || item.graphThreadId !== run.id
        || item.workspaceId !== run.workspaceId || item.workflowId !== run.workflowId) {
        throw new DomainError('INTERACTION_RUN_MISMATCH', 'The graph interrupt does not belong to this Run.', 409)
      }
      const execution = await this.runs.getExecution(item.executionId, owner)
      if (!execution || execution.runId !== run.id || execution.agentId !== item.requestingAgentId
        || execution.nativeSessionId !== item.nativeSessionId) {
        throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'The graph interrupt does not match its durable native execution.', 409)
      }
      if ((item.graphInterruptId && item.graphInterruptId !== pending.id)
        || current.some((other) => other.id === item.id || (other.graphInterruptId === pending.id
          && (other.executionId !== item.executionId || other.nativeSessionId !== item.nativeSessionId)))) {
        throw new DomainError('INTERACTION_INTERRUPT_CONFLICT', 'The interaction has a conflicting graph interrupt identity.', 409)
      }
      // Repair only an absent binding after a checkpoint-write/process crash.
      // Never replace a durable/native identity or redeliver a native response.
      current.push(item.graphInterruptId ? item : await this.interactions.bindGraphInterrupt(item.id, pending.id))
      }
    }
    return current
  }

  private async settleCanceledRun(runId: string, owner: RunOwnership): Promise<void> {
    const run = await this.runs.get(runId, owner)
    if (!run || (run.executionState === 'completed' && !await this.runs.hasPendingCleanup?.(runId, owner.client))) return
    const cleanupFailure = await this.cleanupApprovals(runId)
    await this.settleCanceled(runId, owner, cleanupFailure)
    if (cleanupFailure) throw cleanupFailure.error
  }

  private async cleanupApprovals(runId: string, recordIntent = true): Promise<{ error: unknown } | undefined> {
    try {
      // This durable intent survives business-outcome settlement and a server restart.
      if (recordIntent) await this.runs.requestCleanup?.(runId)
      await this.nativeExecutions.cancelRun(runId)
      return undefined
    } catch (error) {
      return { error }
    }
  }

  private async settleCanceled(runId: string, owner: RunOwnership, cleanupFailure?: { error: unknown }): Promise<boolean> {
    if (await this.runs.isOneShot?.(runId, owner)) {
      const stopped = await this.runs.hasRequestedStop(runId)
      const current = await this.runs.get(runId, owner)
      if (current?.executionState !== 'completed') await this.runs.oneShot(owner).settleRun(stopped, !stopped)
      await this.runs.finishCleanup(runId, Boolean(cleanupFailure))
      return true
    }
    // Terminalize only after native cleanup. A failed closure is not a successful Stop.
    const settled = await this.runs.settleOrphan(runId, owner, !cleanupFailure)
    if (settled && cleanupFailure) {
      const result = cleanupFailedResult()
      await this.runs.updateState(runId, {
        executionState: 'completed', outcome: result.outcome, result, finishedAt: new Date().toISOString(),
      }, owner)
    }
    await this.runs.finishCleanup?.(runId, Boolean(cleanupFailure), owner.client)
    // A terminal business record does not prevent completing its independent cleanup.
    return settled || (!cleanupFailure && (await this.runs.get(runId, owner))?.executionState === 'completed')
  }

  async cancel(runId: string, transactionClient?: import('pg').PoolClient, stopIntent = true): Promise<boolean> {
    // Commit Stop before aborting the local task or waiting on cleanup. Internal
    // cleanup/restart callers explicitly do not manufacture a user Stop intent.
    const oneShot = await this.runs.isOneShot?.(runId) === true
    if (stopIntent && oneShot) await this.runs.requestStop(runId)
    const controller = this.activeRuns.get(runId)
    const activeTask = this.activeTasks.get(runId)
    controller?.abort()
    await this.runs.requestCleanup?.(runId, oneShot ? undefined : transactionClient)
    await this.workerCredentials?.revokeForRun?.(runId, transactionClient)
    // Local native ownership outlives graph tasks and database execution state.
    // Begin its cancellation even if acquiring database ownership later fails.
    const localCleanup = controller || this.nativeExecutions.residentRunIds().includes(runId)
      ? this.cleanupApprovals(runId, false) : undefined
    let drainFailure: { error: unknown } | undefined
    let stoppedTask: unknown
    if (controller) {
      await localCleanup
      if (activeTask) {
        try { await withCleanupDeadline(() => activeTask) } catch (error) {
          // The task may observe this Stop between checkpoint reads. Its own
          // cancellation reason is successful draining, not a cleanup failure.
          if (error !== controller.signal.reason) {
            if (stopIntent && oneShot && error instanceof DomainError && error.code === 'GRAPH_STOP_CONFLICT') stoppedTask = error
            else drainFailure = { error }
          }
        }
      }
      // Stop can race the transition to waiting after graph invocation returns.
      // Re-check durable settlement instead of treating a drained task as Stop.
    }
    let owner: RunOwnership | undefined
    try {
      owner = await this.runs.acquireOwnership(runId, () => undefined)
    } catch (error) {
      const cleanupFailure = await localCleanup
      throw new AggregateError([error, ...(cleanupFailure ? [cleanupFailure.error] : [])], 'Stop could not acquire Run ownership.', { cause: error })
    }
    if (!owner) {
      const cleanupFailure = (await localCleanup) ?? drainFailure
      if (cleanupFailure) throw cleanupFailure.error
      if (stoppedTask) throw stoppedTask
      return false
    }
    try {
      const cleanupFailure = (await (localCleanup ?? this.cleanupApprovals(runId, false))) ?? drainFailure
      const settled = await this.settleCanceled(runId, owner, cleanupFailure)
      if (cleanupFailure) throw cleanupFailure.error
      if (stoppedTask) {
        const current = await this.runs.get(runId, owner)
        if (!await this.runs.hasRequestedStop(runId) || current?.executionState !== 'completed'
          || current.outcome !== 'canceled' || await this.runs.hasPendingCleanup(runId)) throw stoppedTask
      }
      return settled || Boolean(controller)
    } finally {
      await owner.release()
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    // A waiting Run has no active graph task. Runtime shutdown disposes its
    // resident manager later, but must not turn an ordinary restart into Stop.
    const runIds = new Set(this.activeRuns.keys())
    for (const controller of this.activeRuns.values()) controller.abort()
    // Waiting sessions are deliberately included; all cancellations start before
    // any task drain, and a failed sibling must not short-circuit shutdown.
    const reviewerCleanup = this.nativeExecutions.reviewers.shutdown()
    const outcomes = await Promise.allSettled([...runIds].map((runId) => this.cancel(runId, undefined, false)))
    const drains = await Promise.allSettled([
      withCleanupDeadline(() => this.reconciliation ?? Promise.resolve()),
      withCleanupDeadline(async () => { await Promise.allSettled([...this.activeTasks.values(), ...this.resumeTasks.values()]) }),
      withCleanupDeadline(async () => { await reviewerCleanup }),
    ])
    const errors = [...outcomes, ...drains].flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Workflow shutdown cleanup was incomplete.')
  }

  private async executeRun(run: WorkflowRun, signal: AbortSignal, owner: RunOwnership, resumeCommand?: Command): Promise<void> {
    if (isOneShotRun(run)) {
      return executeOneShotRuntime({ run, version: await this.runs.getOneShotVersion(run.workflowVersionId),
        runs: this.runs, workflows: this.workflows, native: this.nativeExecutions, locations: this.locations,
        owner, signal, checkpointer: this.checkpointer, admission: this.workerAdmission,
        configuredParallelism: this.configuredParallelism,
        directory: (nodeId) => this.executionDirectory(run.workspaceId, run.id, nodeId, 1),
        persistWait: (snapshot) => this.persistApprovalWait(run, snapshot, signal, owner),
        ...(resumeCommand ? { resumeCommand } : {}) })
    }
    const startedAt = run.startedAt ?? new Date().toISOString()
    const failedNodes = new AbortController()
    const nodeSignal = AbortSignal.any([signal, failedNodes.signal])
    const activeNodes = new Set<Promise<Partial<EngineStateValue>>>()
    let firstFailure: { error: unknown } | undefined
    let graph: DynamicCompiledGraph | undefined
    let cleanup: Promise<{ error: unknown } | undefined> | undefined
    const cancelNative = () => { cleanup ??= this.cleanupApprovals(run.id) }
    nodeSignal.addEventListener('abort', cancelNative, { once: true })
    if (nodeSignal.aborted) cancelNative()
    const drain = () => withCleanupDeadline(async () => {
      while (activeNodes.size) await Promise.allSettled([...activeNodes])
    })

    try {
      signal.throwIfAborted()
      const version = await this.workflows.getVersion(run.workflowVersionId)
      if (!version) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', `Workflow version '${run.workflowVersionId}' was not found.`, 409)
      if (!run.executionLocation) {
        throw new DomainError('RUN_LOCATION_MISSING', 'This legacy Run has no accepted execution location and cannot be launched.', 409)
      }
      if (run.authorizationPrincipalId) {
        await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
      }
      const configurations = await Promise.all(Object.values(run.agentConfigurationVersionIds).map(async (configurationVersionId) => {
        const configuration = await this.workflows.getAgentConfiguration(configurationVersionId)
        if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', `Configuration '${configurationVersionId}' was not found.`, 500)
        return configuration
      }))
      for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, run.approval,
        run.approval?.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
      if (run.approval) validateWorkflowApproval(version.definition, run.approval, configurations.map((configuration) => ({
        id: configuration.agentId, productRole: configuration.productRole, harnessConfiguration: configuration.harness,
      })))
      await this.locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess(configurations), signal)
      await this.runs.updateState(run.id, { executionState: 'running', outcome: 'pending', startedAt }, owner)
      const topology = validateExecutableTopology(version)
      const limiter = new ExecutionLimiter(version.definition.executionPolicy!.maxParallelism)
      graph = this.buildGraph(version, (nodeId, state) => {
        const task = limiter.run(nodeSignal, () => this.executeNode(run, version, nodeId, topology.incoming.get(nodeId) ?? [], state, nodeSignal, owner))
        activeNodes.add(task)
        void task.then(
          () => { activeNodes.delete(task) },
          (error: unknown) => {
            if (!isGraphInterrupt(error)) {
              firstFailure ??= { error }
              failedNodes.abort(error)
            }
            activeNodes.delete(task)
          },
        )
        return task
      })
      const graphConfig = { configurable: { thread_id: run.id } }
      const state = await withExecutionSignal(graph.invoke(
        resumeCommand ?? { runId: run.id, executionIds: {} },
        { ...graphConfig, signal: nodeSignal },
      ), nodeSignal)
      await drain()
      signal.throwIfAborted()
      if (firstFailure) throw firstFailure.error
      if (await this.persistApprovalWait({ ...run, startedAt }, await graph.getState(graphConfig), signal, owner)) return
      await this.completeRun({ ...run, startedAt }, version, state, signal, owner)
    } catch (error) {
      // A healthy interrupt and recoverable checkpoint I/O retain native work.
      if (!signal.aborted && !firstFailure) {
        await drain()
        owner.assertOwned()
        if (isGraphInterrupt(error) && graph
          && await this.persistApprovalWait({ ...run, startedAt }, await graph.getState({ configurable: { thread_id: run.id } }), signal, owner)) return
        if (resumeCommand) throw error
      }
      failedNodes.abort(error)
      cancelNative()
      const cleanupFailure = await cleanup
      let drainFailed = false
      try { await drain() } catch { drainFailed = true }
      owner.assertOwned()
      const result = cleanupFailure || drainFailed ? cleanupFailedResult() : failedResult(firstFailure?.error ?? error, signal.aborted)
      await this.runs.updateState(run.id, {
        executionState: 'completed',
        outcome: result.outcome,
        result,
        startedAt,
        finishedAt: new Date().toISOString(),
      }, owner)
      await this.runs.finishCleanup?.(run.id, Boolean(cleanupFailure) || drainFailed, owner.client)
    } finally {
      nodeSignal.removeEventListener('abort', cancelNative)
      // Do not abort a successful waiting graph's resident session. Its lifetime
      // is owned by the coordinator until resume, Stop, or shutdown.
    }
  }

  private async persistApprovalWait(run: WorkflowRun, snapshot: GraphSnapshot, signal: AbortSignal, owner: RunOwnership): Promise<boolean> {
    if (!snapshot.tasks.some((task) => task.interrupts?.length)) return false
    await this.currentInteractions(run, snapshot, owner)
    signal.throwIfAborted()
    await this.runs.updateState(run.id, { executionState: 'waiting', outcome: 'pending', startedAt: run.startedAt ?? new Date().toISOString() }, owner)
    signal.throwIfAborted()
    await this.nativeExecutions.reconcileReviews(console.error).catch(console.error)
    return true
  }

  private async completeRun(run: WorkflowRun, version: WorkflowVersion, state: EngineStateValue, signal: AbortSignal, owner: RunOwnership): Promise<void> {
    signal.throwIfAborted()
    if (isOneShotRun(run)) {
      await this.runs.oneShot(owner).completeRun()
      await this.runs.requestCleanup(run.id)
      await this.nativeExecutions.finishRun(run.id)
      await this.runs.finishCleanup(run.id, false)
      return
    }
    const topology = validateExecutableTopology(version)
    const finalOutputs = await Promise.all(topology.sinks.map(async (nodeId) => {
      const executionId = state.executionIds[nodeId]
      if (!executionId) throw new DomainError('FINAL_EXECUTION_MISSING', `Final node '${nodeId}' did not produce an execution.`, 500)
      const result = await this.runs.getAcceptedResult(executionId, owner)
      if (!result) throw new DomainError('FINAL_RESULT_MISSING', `Final node '${nodeId}' has no accepted result.`, 500)
      return { nodeId, executionId, result: result.output ?? null }
    }))
    const result: ExecutionResult = {
      outcome: 'succeeded',
      output: finalOutputs.length === 1 ? finalOutputs[0]?.result ?? null : { outputs: finalOutputs },
    }
    signal.throwIfAborted()
    await this.runs.updateState(run.id, {
      executionState: 'completed', outcome: 'succeeded', result,
      startedAt: run.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(),
    }, owner)
    await this.nativeExecutions.finishRun(run.id)
  }

  private async executeNode(
    run: WorkflowRun,
    version: WorkflowVersion,
    nodeId: string,
    predecessorNodeIds: string[],
    state: EngineStateValue,
    signal: AbortSignal,
    owner: RunOwnership,
  ): Promise<Partial<EngineStateValue>> {
    signal.throwIfAborted()
    owner.assertOwned()
    const node = version.definition.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', `Node '${nodeId}' was not found.`, 500)
    const configurationVersionId = run.agentConfigurationVersionIds[node.agentId]
    if (!configurationVersionId) throw new DomainError('AGENT_CONFIGURATION_NOT_PINNED', `Agent '${node.agentId}' has no pinned configuration.`, 500)
    const configuration = await this.workflows.getAgentConfiguration(configurationVersionId)
    if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', `Configuration '${configurationVersionId}' was not found.`, 500)

    const predecessorResults = await Promise.all(predecessorNodeIds.map(async (predecessorNodeId) => {
      const executionId = state.executionIds[predecessorNodeId]
      if (!executionId) throw new DomainError('HANDOFF_EXECUTION_MISSING', `Dependency '${predecessorNodeId}' has no execution.`, 500)
      const accepted = await this.runs.getAcceptedResult(executionId, owner)
      if (!accepted) throw new DomainError('HANDOFF_RESULT_MISSING', `Dependency execution '${executionId}' has no accepted result.`, 500)
      return { predecessorNodeId, executionId, result: accepted.output ?? null }
    }))
    const input = predecessorResults.length === 0
      ? run.input
      : predecessorResults.length === 1
        ? { previous: predecessorResults[0] }
        : { predecessors: predecessorResults }
    const executionId = `execution-${randomUUID()}`
    if (!run.executionLocation) throw new DomainError('RUN_LOCATION_MISSING', 'This Run has no accepted execution location.', 409)
    if (run.authorizationPrincipalId) {
      await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
    }
    await this.locations.revalidateSnapshot(
      run.workspaceId, run.executionLocation, requiredLocationAccess([configuration]), signal,
    )
    const workingDirectory = run.executionLocation.rootPath
    const runtimeDirectory = this.executionDirectory(run.workspaceId, run.id, nodeId, 1)
    await withFilesystemDeadline((check) => check(() => mkdir(runtimeDirectory, { recursive: true })), signal)
    signal.throwIfAborted()
    owner.assertOwned()
    const now = new Date().toISOString()
    let execution = HarnessExecutionSchema.parse({
      id: executionId,
      runId: run.id,
      workflowNodeId: nodeId,
      agentId: node.agentId,
      agentConfigurationVersionId: configurationVersionId,
      workingDirectory,
      runtimeDirectory,
      attempt: 1,
      input,
      state: 'starting',
      createdAt: now,
      startedAt: now,
    })
    const request = HarnessExecutionRequestSchema.parse({
      executionId,
      runId: run.id,
      workspaceId: run.workspaceId,
      workflowNodeId: nodeId,
      workingDirectory,
      runtimeDirectory,
      initialPrompt: node.initialPrompt,
      configuration,
      input,
    })
    for (;;) {
      const observation = await this.nativeExecutions.ensureObserve({
        candidate: execution, request, approval: run.approval, workflowId: run.workflowId,
        graphThreadId: run.id, owner, signal,
      })
      execution = observation.execution
      if (observation.state === 'waiting') {
        const resumed: unknown = interrupt({
          interactionId: observation.interaction.id,
          interactionIds: observation.interactions.map((item) => item.id),
        })
        // On node re-entry LangGraph can return an earlier delivery while a
        // later native request is already pending. Validate the exact delivered
        // identity, then observe again; never apply that value to the new ask.
        await this.nativeExecutions.assertResume(execution, resumed)
        continue
      }
      if (observation.result.outcome !== 'succeeded') {
        throw new DomainError(
          observation.result.error?.code ?? 'NATIVE_EXECUTION_FAILED',
          observation.result.error?.message ?? 'The native execution did not succeed.', 409,
        )
      }
      await this.runs.acceptExecutionResult(execution, owner)
      return { executionIds: { [nodeId]: execution.id } }
    }
  }

  private executionDirectory(workspaceId: string, runId: string, nodeId: string, attempt: number): string {
    return resolveExecutionDirectory(this.workspaceRoot, runId, nodeId, attempt, workspaceId)
  }
}
