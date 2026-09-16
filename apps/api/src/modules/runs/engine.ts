import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Annotation, Command, END, START, StateGraph, interrupt, isGraphInterrupt } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import {
  HarnessExecutionRequestSchema,
  HarnessExecutionSchema,
  HarnessNativeEventSchema,
  type ExecutionResult,
  type WorkflowRun,
  type WorkflowVersion,
  type DurableInteraction,
} from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import type { HarnessResolver, NativeEventInput } from '../harnesses/port.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import type { WorkflowOrchestrator } from './port.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import { ExecutionLimiter } from './limiter.js'
import { validateExecutableTopology } from './topology.js'
import { resolveExecutionDirectory } from './executionDirectory.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { IssuedWorkerCredential } from '../access/workerCredentials.js'

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

export class LangGraphWorkflowEngine implements WorkflowOrchestrator {
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeTasks = new Map<string, Promise<void>>()
  private readonly resumeTasks = new Map<string, Promise<void>>()
  private readonly workspaceRoot: string
  private closing = false
  private reconciliation: Promise<void> | undefined

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly harnesses: HarnessResolver,
    private readonly checkpointer: BaseCheckpointSaver,
    workspaceRoot: string,
    private readonly timeoutMs: number,
    private readonly locations: WorkspaceLocationService,
    private readonly workerCredentials?: ExecutionCredentialProvider,
    private readonly approvals?: ApprovalExecutionCoordinator,
    private readonly interactions?: PostgresInteractionRepository,
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  start(runId: string): Promise<void> {
    const existing = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId)
    if (existing) return existing
    return this.trackRun(runId, (controller) => this.startRun(runId, controller))
  }

  private trackRun(runId: string, work: (controller: AbortController) => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    // Register cancellation before the first database await, including queued work.
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const task = work(controller).finally(() => {
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      if (this.activeTasks.get(runId) === task) this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  private async startRun(runId: string, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    timeout.unref()
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
        await this.runs.settleOrphan(runId, owner, true)
        return
      }
      await this.executeRun(run, controller.signal, owner)
    } finally {
      clearTimeout(timeout)
      await owner?.release()
    }
  }

  /** Recover queued work; do not replay interrupted native side effects. */
  reconcile(onError: (error: unknown) => void = console.error): Promise<void> {
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const task = (async () => {
      await this.approvals?.reconcileReviews(onError)
      for (const candidate of await this.runs.reconciliationCandidates()) {
        if (this.closing) break
        if (this.activeTasks.has(candidate.id) || this.resumeTasks.has(candidate.id)) continue
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
      if (run.approval) {
        const { version, snapshot } = await this.readCheckpoint(run)
        if (this.isApprovalWait(snapshot)) {
          const current = await this.currentInteractions(run, snapshot, owner)
          controller.signal.throwIfAborted()
          if (run.executionState !== 'waiting') {
            await this.runs.updateState(run.id, { executionState: 'waiting', outcome: 'pending' }, owner)
          }
          const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
          if (delivered.length) await this.resumeCheckpoint(run, delivered, controller, owner)
          return
        }
        if (this.isTerminalCheckpoint(run, snapshot)) {
          await this.completeRun(run, version, snapshot.values as EngineStateValue, controller.signal, owner)
          return
        }
      }
      // No healthy interrupt or terminal checkpoint: never replay orphaned work.
      await this.approvals?.cancelRun(runId)
      await this.runs.settleOrphan(runId, owner, false)
    } finally {
      try {
        if (controller.signal.aborted) await this.settleCanceledRun(runId, owner)
      } finally { await owner.release() }
    }
  }

  async resume(runId: string): Promise<void> {
    await this.queueResume(runId)
  }

  async resumeInteraction(interaction: DurableInteraction): Promise<void> {
    await this.resumeInteractions([interaction])
  }

  private async resumeInteractions(interactions: DurableInteraction[]): Promise<void> {
    const runId = interactions[0]?.runId
    if (!runId || interactions.some((item) => item.runId !== runId)) throw new DomainError('INTERACTION_RUN_MISMATCH', 'Resume interactions must belong to one Run.', 409)
    await this.queueResume(runId, interactions.map((item) => item.id))
  }

  private queueResume(runId: string, requestedIds?: string[]): Promise<void> {
    if (!this.interactions || !this.approvals) return Promise.reject(new DomainError('RUN_RESUME_NOT_IMPLEMENTED', `Run '${runId}' has no durable approval runtime.`, 501))
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    // Publish the queue tail synchronously. Waiting callers must not all replace
    // the same active task/controller after a shared predecessor settles.
    const previous = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() =>
      this.trackRun(runId, (controller) => this.resumeRun(runId, controller, requestedIds)),
    ).finally(() => {
      if (this.resumeTasks.get(runId) === task) this.resumeTasks.delete(runId)
    })
    this.resumeTasks.set(runId, task)
    return task
  }

  private async resumeRun(runId: string, controller: AbortController, requestedIds?: string[]): Promise<void> {
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
      if (requestedIds && !current.some((item) => requestedIds.includes(item.id))) return
      // Resolve by CURRENT checkpoint IDs, not a page of historical interactions.
      // Include every delivered branch in one map; leave undecided branches alone.
      const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
      if (!delivered.length) throw new DomainError('RUN_NOT_RESUMABLE', `Run '${runId}' has no delivered graph interrupt.`, 409)
      await this.resumeCheckpoint(run, delivered, controller, owner)
    } finally {
      try {
        if (owner && controller.signal.aborted) await this.settleCanceledRun(runId, owner)
      } finally { await owner?.release() }
    }
  }

  private async resumeCheckpoint(run: WorkflowRun, interactions: DurableInteraction[], controller: AbortController, owner: RunOwnership): Promise<void> {
    if (!this.approvals) throw new DomainError('APPROVAL_RUNTIME_MISSING', 'The Run has no durable approval runtime.', 503)
    const resumeMap = Object.fromEntries(interactions.map((item) => [item.graphInterruptId!, { interactionId: item.id }]))
    const budgetReadStarted = performance.now()
    const remainingMs = await this.runs.remainingApprovalTime(run.id, interactions.map((item) => item.executionId), owner)
    const expire = () => controller.abort(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409))
    const timeoutMs = Math.max(0, remainingMs - (performance.now() - budgetReadStarted))
    if (timeoutMs === 0) expire()
    const timeout = setTimeout(expire, timeoutMs)
    timeout.unref()
    try {
      await this.executeRun(run, controller.signal, owner, new Command({ resume: resumeMap }))
    } finally { clearTimeout(timeout) }
  }

  private buildGraph(version: WorkflowVersion, action: (nodeId: string, state: EngineStateValue) => Promise<Partial<EngineStateValue>>): DynamicCompiledGraph {
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
    const version = await this.workflows.getVersion(run.workflowVersionId)
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
      const value = pending.value as { interactionId?: unknown }
      if (!pending.id || typeof value?.interactionId !== 'string') throw new DomainError('GRAPH_INTERRUPT_INVALID', 'The graph interrupt has no interaction identity.', 500)
      const item = await this.interactions.get(value.interactionId)
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
        || current.some((other) => other.id === item.id || other.graphInterruptId === pending.id)) {
        throw new DomainError('INTERACTION_INTERRUPT_CONFLICT', 'The interaction has a conflicting graph interrupt identity.', 409)
      }
      // Repair only an absent binding after a checkpoint-write/process crash.
      // Never replace a durable/native identity or redeliver a native response.
      current.push(item.graphInterruptId ? item : await this.interactions.bindGraphInterrupt(item.id, pending.id))
    }
    return current
  }

  private async settleCanceledRun(runId: string, owner: RunOwnership): Promise<void> {
    const run = await this.runs.get(runId, owner)
    if (!run || run.executionState === 'completed') return
    await this.approvals?.cancelRun(runId)
    await this.runs.settleOrphan(runId, owner, true)
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.activeRuns.get(runId)
    if (controller) {
      controller.abort()
      await this.approvals?.cancelRun(runId)
      return true
    }
    const owner = await this.runs.acquireOwnership(runId, () => undefined)
    if (!owner) return false
    try {
      const settled = await this.runs.settleOrphan(runId, owner, true)
      if (settled) await this.approvals?.cancelRun(runId)
      return settled
    } finally {
      await owner.release()
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    for (const controller of this.activeRuns.values()) controller.abort()
    await this.reconciliation?.catch(() => undefined)
    await this.approvals?.reviewers.shutdown()
    await Promise.allSettled([...this.activeTasks.values(), ...this.resumeTasks.values()])
  }

  private async executeRun(run: WorkflowRun, signal: AbortSignal, owner: RunOwnership, resumeCommand?: Command): Promise<void> {
    const startedAt = run.startedAt ?? new Date().toISOString()
    const failedNodes = new AbortController()
    const nodeSignal = AbortSignal.any([signal, failedNodes.signal])
    const activeNodes = new Set<Promise<Partial<EngineStateValue>>>()
    let firstFailure: { error: unknown } | undefined
    let graph: DynamicCompiledGraph | undefined
    const drain = async () => {
      while (activeNodes.size) await Promise.allSettled([...activeNodes])
    }

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
      const state = await graph.invoke(
        resumeCommand ?? { runId: run.id, executionIds: {} },
        { ...graphConfig, signal: nodeSignal },
      )
      await drain()
      signal.throwIfAborted()
      if (firstFailure) throw firstFailure.error
      if (await this.persistApprovalWait({ ...run, startedAt }, await graph.getState(graphConfig), signal, owner)) return
      await this.completeRun({ ...run, startedAt }, version, state, signal, owner)
    } catch (error) {
      // A graph interrupt is a checkpoint boundary, not sibling failure.
      if (!isGraphInterrupt(error)) failedNodes.abort(error)
      // Abort is cooperative. Start native cancellation before draining so a
      // resumed observation can unwind even when it awaits provider I/O.
      if (signal.aborted || firstFailure) owner.assertOwned()
      const canceling = signal.aborted || firstFailure ? this.approvals?.cancelRun(run.id) : undefined
      void canceling?.catch(() => undefined)
      // Retain local tracking and database ownership until all launched tasks clean up.
      await drain()
      await canceling
      owner.assertOwned()
      if (!signal.aborted && !firstFailure) {
        if (isGraphInterrupt(error) && graph
          && await this.persistApprovalWait({ ...run, startedAt }, await graph.getState({ configurable: { thread_id: run.id } }), signal, owner)) return
        // Failed resume/checkpoint I/O is not an acknowledgment. The durable
        // delivered interaction and checkpoint remain available to reconciliation.
        if (resumeCommand) throw error
      }
      if (!canceling) await this.approvals?.cancelRun(run.id, owner)
      const result = failedResult(firstFailure?.error ?? error, signal.aborted)
      await this.runs.updateState(run.id, {
        executionState: 'completed',
        outcome: result.outcome,
        result,
        startedAt,
        finishedAt: new Date().toISOString(),
      }, owner)
    } finally {
      failedNodes.abort()
      await drain()
    }
  }

  private async persistApprovalWait(run: WorkflowRun, snapshot: GraphSnapshot, signal: AbortSignal, owner: RunOwnership): Promise<boolean> {
    if (!snapshot.tasks.some((task) => task.interrupts?.length)) return false
    await this.currentInteractions(run, snapshot, owner)
    signal.throwIfAborted()
    await this.runs.updateState(run.id, { executionState: 'waiting', outcome: 'pending', startedAt: run.startedAt ?? new Date().toISOString() }, owner)
    signal.throwIfAborted()
    return true
  }

  private async completeRun(run: WorkflowRun, version: WorkflowVersion, state: EngineStateValue, signal: AbortSignal, owner: RunOwnership): Promise<void> {
    signal.throwIfAborted()
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
    if (!this.approvals || !run.approval) await this.runs.createExecution(execution, owner)
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
    let eventSequence = 0
    let workerCredential: IssuedWorkerCredential | undefined

    if (this.approvals && run.approval) {
      for (;;) {
        const observation = await this.approvals.ensureObserve({
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
          await this.approvals.assertResume(execution, resumed)
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

    const adapter = this.harnesses.resolve(configuration.harness.harness)
    try {
      signal.throwIfAborted()
      owner.assertOwned()
      const result = await (async () => {
        try {
          return await adapter.execute(request, {
            signal,
            beforeSpawn: async () => {
              signal.throwIfAborted()
              owner.assertOwned()
              if (run.authorizationPrincipalId) {
                await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
              }
              await this.locations.revalidateSnapshot(
                run.workspaceId, run.executionLocation!, requiredLocationAccess([configuration]), signal,
              )
              signal.throwIfAborted()
              owner.assertOwned()
              if (this.workerCredentials) {
                if (workerCredential) throw new DomainError('WORKER_CREDENTIAL_ALREADY_ISSUED', 'This execution already received an App credential.', 500)
                const prepared = await this.workerCredentials.prepare({
                  executionId,
                  harness: configuration.harness.harness,
                  workingDirectory,
                  signal,
                })
                workerCredential = prepared.credential
                return prepared.credential.environment
              }
            },
            onSession: async (nativeSessionId) => {
              execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId, state: 'running' })
              await this.runs.updateExecution(execution, owner)
              await this.runs.recordActivity(run.id, 'harness', 'harness_session_started', {
                workflowNodeId: nodeId,
                agentId: node.agentId,
                nativeSessionId,
                harness: configuration.harness.harness,
              }, executionId, owner.client)
            },
            onEvent: async (event: NativeEventInput) => {
              const nativeEvent = HarnessNativeEventSchema.parse({
                executionId,
                sequence: eventSequence,
                type: event.type,
                occurredAt: new Date().toISOString(),
                payload: event.payload,
              })
              eventSequence += 1
              await this.runs.appendNativeEvent(nativeEvent, owner)
            },
          })
        } finally {
          if (workerCredential && this.workerCredentials) {
            await this.workerCredentials.revoke(workerCredential)
            workerCredential = undefined
          }
        }
      })()
      signal.throwIfAborted()
      execution = HarnessExecutionSchema.parse({
        ...execution,
        state: 'completed',
        result,
        finishedAt: new Date().toISOString(),
      })
      await this.runs.acceptExecutionResult(execution, owner)
      await this.runs.recordActivity(run.id, 'harness', 'harness_session_finished', {
        workflowNodeId: nodeId,
        outcome: result.outcome,
      }, executionId, owner.client)
      return { executionIds: { [nodeId]: executionId } }
    } catch (error) {
      const result = failedResult(error, signal.aborted)
      execution = HarnessExecutionSchema.parse({
        ...execution,
        state: 'completed',
        result,
        finishedAt: new Date().toISOString(),
      })
      await this.runs.updateExecution(execution, owner)
      await this.runs.recordActivity(run.id, 'harness', 'harness_session_finished', {
        workflowNodeId: nodeId,
        outcome: result.outcome,
        error: result.error ?? null,
      }, executionId, owner.client)
      throw error
    }
  }

  private executionDirectory(workspaceId: string, runId: string, nodeId: string, attempt: number): string {
    return resolveExecutionDirectory(this.workspaceRoot, runId, nodeId, attempt, workspaceId)
  }
}
