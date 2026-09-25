import { resolve } from 'node:path'
import type pg from 'pg'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { DurableInteraction } from '@graphql/contracts'
import { AcceptedWorkflowRunV3Schema, type AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import type { GraphResumeClaim } from '../interactions/deliveryPostgres.js'
import { withCleanupDeadline } from '../interactions/cleanup.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { executeRepeatEngineStart, type RepeatEngineStartContext } from './repeatStartComposition.js'
import { runStartSemantics } from './repeatStartDispatch.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import type { WorkflowOrchestrator } from './port.js'
import { RunnerAdmission } from './runnerAdmission.js'

/** A2 implements this on the same owner/checkpointer; A3 supplies its locked SQL
 * ports. Read the CURRENT checkpoint, authenticate requested IDs and the exact
 * source/receipt/owner/session/generation, and commit task-local resume writes
 * before returning ready. With no interrupt, ready simply means continuation.
 * A notification is not authority. No raw LangGraph Command is accepted here. */
export interface CurrentEngineRuntimeBinding extends Pick<RepeatEngineStartContext, 'lifecycle' | 'nativeBoundaryEvidence'> {
  prepareContinuation(input: {
    run: AcceptedWorkflowRunV3
    checkpointer: BaseCheckpointSaver
    requestedInteractionIds?: readonly string[]
    claim?: GraphResumeClaim
  }): Promise<'ready' | 'waiting' | 'stale'>
}
/** Kept as the existing composition symbol, not a different repeat engine or
 * repeat-only admission switch. Every ordinary/repeated V3 uses this binding. */
export type RepeatEngineRuntimeBinding = (owner: RunOwnership, signal: AbortSignal) => CurrentEngineRuntimeBinding

/** One entry, Run owner, checkpoint thread and worker gate for all current V3
 * graphs. Only explicit blocks add repeat boundaries to the common graph. */
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
    private readonly workerCredentials?: ExecutionCredentialProvider,
    // Preserve the established constructor's position for A2 production wiring.
    _interactions?: PostgresInteractionRepository,
    private readonly onRunTerminal?: (runId: string, reason: string) => Promise<void>,
    limits: { workerParallelism?: number; maximumWaiting?: number; maximumActiveRuns?: number } = {},
    private readonly repeatRuntimeBinding?: RepeatEngineRuntimeBinding,
  ) {
    void _interactions // A2 owns the composed continuation service, not a second engine resume path.
    this.workspaceRoot = resolve(workspaceRoot)
    this.configuredParallelism = limits.workerParallelism ?? 4
    this.maximumActiveRuns = limits.maximumActiveRuns ?? 32
    this.workerAdmission = new RunnerAdmission(this.configuredParallelism, limits.maximumWaiting ?? 1000, this.maximumActiveRuns)
  }

  start(runId: string): Promise<void> {
    const existing = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId)
    return existing ?? this.trackRun(runId, (controller) => this.drive(runId, controller))
  }

  private trackRun(runId: string, work: (controller: AbortController) => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    const existing = this.activeTasks.get(runId)
    if (existing) return existing
    if (this.activeTasks.size >= this.maximumActiveRuns) return Promise.reject(new DomainError(
      'RUNNER_ADMISSION_FULL', 'The active Run limit is reached; durable queued work was not launched.', 503))
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    // Publish synchronously before owner acquisition; concurrent Start deduplicates
    // and Stop can abort work during the very first database await.
    const task = Promise.resolve().then(() => work(controller)).finally(() => {
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      if (this.activeTasks.get(runId) === task) this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  private binding(owner: RunOwnership, signal: AbortSignal): CurrentEngineRuntimeBinding {
    owner.assertOwned()
    const value = this.repeatRuntimeBinding?.(owner, signal)
    if (!value || typeof value.nativeBoundaryEvidence !== 'function' || typeof value.prepareContinuation !== 'function'
      || !value.lifecycle || ['preflight', 'markRunning', 'currentState', 'persistWait', 'cancelNativeAndRequestCleanup',
        'settleRun', 'requestCleanup', 'finishNative', 'finishCleanup'].some((key) =>
        typeof value.lifecycle[key as keyof typeof value.lifecycle] !== 'function')) {
      throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'The current V3 native, lifecycle and exact continuation ports must be composed.', 409)
    }
    return value
  }

  private currentRun(value: unknown): AcceptedWorkflowRunV3 {
    runStartSemantics({ executionSemanticsVersion: value && typeof value === 'object' && 'executionSemanticsVersion' in value
      ? value.executionSemanticsVersion : undefined })
    return AcceptedWorkflowRunV3Schema.parse(value)
  }

  private async drive(runId: string, controller: AbortController, requestedIds?: readonly string[], claim?: GraphResumeClaim): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => controller.abort(new DomainError(
      'RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409)))
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'This Run is owned by another engine.', 409)
    try {
      const raw = await this.runs.get(runId, owner)
      if (!raw) throw new DomainError('RUN_NOT_FOUND', 'The exact Run was not found.', 404)
      const run = this.currentRun(raw) // denies retired/missing/unknown pins before any lifecycle or native callback
      owner.assertOwned(); controller.signal.throwIfAborted()
      if (owner.runId !== run.id) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'A Run cannot borrow another owner.', 409)
      const binding = this.binding(owner, controller.signal)
      const snapshot = await this.runs.getRepeatSnapshot(runId, owner)
      if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') {
        await this.cleanupOwned(owner, binding)
        return
      }
      if (!['queued', 'running', 'waiting'].includes(snapshot.run.executionState)) throw new DomainError(
        'RUN_NOT_RESUMABLE', 'The Run requires authoritative settlement, not another initial invocation.', 409)
      if (requestedIds || snapshot.run.executionState !== 'queued') {
        if (snapshot.run.executionState === 'queued' && requestedIds) return
        const state = await binding.prepareContinuation({ run: snapshot.run, checkpointer: this.checkpointer,
          ...(requestedIds ? { requestedInteractionIds: [...requestedIds] } : {}), ...(claim ? { claim } : {}) })
        if (state !== 'ready') return
      }
      owner.assertOwned(); controller.signal.throwIfAborted()
      // executeRepeatEngineStart rechecks the exact immutable snapshot and the
      // negative fences. No branch on graph complexity or repeat presence.
      await executeRepeatEngineStart({ owner, signal: controller.signal, factory: this.runs.repeatRepositoryFactory(),
        lifecycle: binding.lifecycle, nativeBoundaryEvidence: binding.nativeBoundaryEvidence.bind(binding),
        runtimeRoot: this.workspaceRoot, checkpointer: this.checkpointer, admission: this.workerAdmission,
        configuredParallelism: this.configuredParallelism, native: this.nativeExecutions,
        workflows: this.workflows, locations: this.locations })
      if ((await this.runs.getRepeatSnapshot(runId, owner)).run.executionState === 'completed') {
        await this.finishOwned(owner, binding)
      }
    } finally {
      // During restart, original native closure finishes (or explicitly fails)
      // before releasing the owner that captured that evidence.
      try { if (this.restartClosure) await this.restartClosure } finally { await owner.release() }
    }
  }

  resume(runId: string): Promise<void> { return this.queueResume(runId) }

  resumeInteraction(interaction: DurableInteraction, claim?: GraphResumeClaim): Promise<void> {
    if (!interaction.runId || interaction.graphThreadId !== interaction.runId) return Promise.reject(new DomainError(
      'INTERACTION_RUN_MISMATCH', 'Resume must select the exact Run checkpoint.', 409))
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

  private async finishOwned(owner: RunOwnership, binding: CurrentEngineRuntimeBinding,
    reason = 'The Run stopped or completed.'): Promise<void> {
    const snapshot = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (snapshot.run.executionState !== 'completed') throw new DomainError(
      'GRAPH_TERMINAL_CONFLICT', 'The Run has not settled.', 409)
    // The runtime may already have durably finished native cleanup. A notification
    // must not reopen settled work unless this engine also owes a terminal hook.
    if (!snapshot.cleanupPending && !this.onRunTerminal) return
    if (!snapshot.cleanupPending) await binding.lifecycle.requestCleanup()
    await binding.lifecycle.finishNative()
    await this.onRunTerminal?.(owner.runId, reason)
    await binding.lifecycle.finishCleanup()
  }

  private async cleanupOwned(owner: RunOwnership, binding: CurrentEngineRuntimeBinding): Promise<boolean> {
    const snapshot = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') throw new DomainError(
      'GRAPH_STOP_CONFLICT', 'Cleanup requires a committed Stop, cleanup or terminal fence.', 409)
    if (snapshot.run.executionState === 'completed' && !snapshot.cleanupPending) {
      await this.finishOwned(owner, binding)
      return !(await this.runs.getRepeatSnapshot(owner.runId, owner)).cleanupPending
    }
    if (!snapshot.cleanupPending) await binding.lifecycle.requestCleanup()
    if (snapshot.run.executionState !== 'completed') {
      const clean = await binding.lifecycle.cancelNativeAndRequestCleanup()
      await binding.lifecycle.settleRun(snapshot.stopRequested, !snapshot.stopRequested)
      if (!clean) return false
    }
    if ((await this.runs.getRepeatSnapshot(owner.runId, owner)).run.executionState !== 'completed') return false
    await this.finishOwned(owner, binding)
    const final = await this.runs.getRepeatSnapshot(owner.runId, owner)
    return final.run.executionState === 'completed' && !final.cleanupPending
  }

  async finishRunLifecycle(runId: string, reason = 'The Run stopped or completed.'): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => undefined)
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'The current owner must finish cleanup.', 409)
    try { await this.finishOwned(owner, this.binding(owner, new AbortController().signal), reason) }
    finally { await owner.release() }
  }

  /** The shared authorized Stop command commits its negative fence first. A raw
   * transaction client, callback return or process absence is not that proof.
   * stopIntent is retained solely as a call-site argument, never inferred authority. */
  async cancel(runId: string, transactionClient?: pg.PoolClient, _stopIntent = true): Promise<boolean> {
    void _stopIntent // A caller Boolean is never Stop authorization.
    if (transactionClient) throw new DomainError('GRAPH_TRANSACTION_CONTEXT_REQUIRED', 'Finish the authorized Stop transaction before native cleanup.', 409)
    const snapshot = await this.runs.getRepeatSnapshot(runId)
    this.currentRun(snapshot.run)
    if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') throw new DomainError(
      'REPEAT_STOP_AUTHORIZATION_REQUIRED', 'Commit the authorized V3 Stop before native cancellation.', 409)
    const existing = this.cleanupTasks.get(runId)
    if (existing) return existing
    this.activeRuns.get(runId)?.abort(new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a durable Stop or cleanup request.', 409))
    const task = (async () => {
      // The durable negative fence prevents any new native dispatch while the
      // current graph owner drains. Failures retain cleanup intent for recovery.
      const active = this.activeTasks.get(runId)
      const physical = snapshot.run.executionState === 'completed' ? Promise.resolve() : this.nativeExecutions.cancelRun(runId)
      await withCleanupDeadline(async () => { await Promise.allSettled([physical, ...(active ? [active] : [])]) })
      const owner = await this.runs.acquireOwnership(runId, () => undefined)
      if (!owner) return false
      try { return await this.cleanupOwned(owner, this.binding(owner, new AbortController().signal)) }
      finally { await owner.release() }
    })().finally(() => { if (this.cleanupTasks.get(runId) === task) this.cleanupTasks.delete(runId) })
    this.cleanupTasks.set(runId, task)
    return task
  }

  reconcile(onError: (error: unknown) => void = console.error): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const task = (async () => {
      await this.workerCredentials?.reconcileTerminalCredentials?.().catch(onError)
      await this.nativeExecutions.reconcileReviews(onError)
      for (const candidate of await this.runs.reconciliationCandidates()) {
        if (this.closing || this.activeTasks.size >= this.maximumActiveRuns) break
        if (this.activeTasks.has(candidate.id) || this.resumeTasks.has(candidate.id) || this.cleanupTasks.has(candidate.id)) continue
        try { this.currentRun(candidate) } catch (error) { onError(error); continue }
        void this.start(candidate.id).catch(onError)
      }
    })().finally(() => { if (this.reconciliation === task) this.reconciliation = undefined })
    this.reconciliation = task
    return task
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closing = true
    this.restartClosure = Promise.resolve().then(() => this.nativeExecutions.closeForRestart())
    // Install a rejection observer immediately; the same error is reported below.
    void this.restartClosure.catch(() => undefined)
    for (const controller of this.activeRuns.values()) controller.abort(new DomainError(
      'ENGINE_RESTART', 'Preserve the exact checkpoint for restart; this is not user Stop.', 409))
    this.shutdownTask = (async () => {
      const outcomes = await Promise.allSettled([
        this.restartClosure!,
        withCleanupDeadline(async () => { await Promise.allSettled([...this.activeTasks.values(), ...this.resumeTasks.values()]) }),
        ...this.cleanupTasks.values(),
      ])
      const errors = outcomes.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Native restart closure or task draining remains unconfirmed.')
    })()
    return this.shutdownTask
  }
}
