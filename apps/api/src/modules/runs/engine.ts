import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph'
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

const EngineState = Annotation.Root({
  runId: Annotation<string>(),
  executionIds: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
})
type EngineStateValue = typeof EngineState.State

interface DynamicCompiledGraph {
  invoke(
    input: EngineStateValue | Command,
    config: { configurable: { thread_id: string } },
  ): Promise<EngineStateValue>
  getState(config: { configurable: { thread_id: string } }): Promise<{
    tasks: Array<{ interrupts?: Array<{ id: string; value: unknown }> }>
  }>
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
    private readonly approvals?: ApprovalExecutionCoordinator,
    private readonly interactions?: PostgresInteractionRepository,
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  start(runId: string): Promise<void> {
    const existing = this.activeTasks.get(runId)
    if (existing) return existing
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    // Register cancellation before the first database await, including queued work.
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const task = this.startRun(runId, controller).finally(() => {
      this.activeRuns.delete(runId)
      this.activeTasks.delete(runId)
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
      for (const candidate of await this.runs.reconciliationCandidates()) {
        if (this.closing) break
        if (this.activeTasks.has(candidate.id)) continue
        if (candidate.executionState === 'queued') {
          void this.start(candidate.id).catch(onError)
          continue
        }
        const owner = await this.runs.acquireOwnership(candidate.id, () => undefined)
        if (!owner) continue
        try {
          await this.runs.settleOrphan(candidate.id, owner, false)
        } finally {
          await owner.release()
        }
      }
    })().finally(() => { this.reconciliation = undefined })
    this.reconciliation = task
    return task
  }

  async resume(runId: string): Promise<void> {
    if (!this.interactions) throw new DomainError('RUN_RESUME_NOT_IMPLEMENTED', `Run '${runId}' has no durable approval runtime.`, 501)
    const pending = (await this.interactions.list({ runId, limit: 100 }))
      .filter((item) => item.deliveryState === 'delivered' && item.graphInterruptId)
    if (!pending.length) throw new DomainError('RUN_NOT_RESUMABLE', `Run '${runId}' has no delivered graph interrupt.`, 409)
    await this.resumeInteractions(pending)
  }

  async resumeInteraction(interaction: DurableInteraction): Promise<void> {
    await this.resumeInteractions([interaction])
  }

  private async resumeInteractions(interactions: DurableInteraction[]): Promise<void> {
    const runId = interactions[0]?.runId
    if (!runId || interactions.some((item) => item.runId !== runId)) throw new DomainError('INTERACTION_RUN_MISMATCH', 'Resume interactions must belong to one Run.', 409)
    const existing = this.activeTasks.get(runId)
    if (existing) await existing
    if (this.closing) throw new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503)
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const task = this.resumeRun(runId, interactions, controller).finally(() => {
      this.activeRuns.delete(runId)
      this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    await task
  }

  private async resumeRun(runId: string, interactions: DurableInteraction[], controller: AbortController): Promise<void> {
    let owner: RunOwnership | undefined
    try {
      owner = await this.runs.acquireOwnership(runId, () => controller.abort(
        new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409),
      ))
      if (!owner) throw new DomainError('RUN_ALREADY_OWNED', `Run '${runId}' is owned by another engine.`, 409)
      const run = await this.runs.get(runId, owner)
      if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
      if (run.executionState !== 'waiting') throw new DomainError('RUN_NOT_RESUMABLE', `Run '${runId}' is not waiting.`, 409)
      const resumeMap: Record<string, unknown> = {}
      for (const item of interactions) {
        if (!item.graphInterruptId) throw new DomainError('INTERACTION_INTERRUPT_MISSING', 'The interaction has no durable graph interrupt identity.', 409)
        resumeMap[item.graphInterruptId] = { interactionId: item.id }
      }
      await this.executeRun(run, controller.signal, owner, new Command({ resume: resumeMap }))
    } finally { await owner?.release() }
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
    await Promise.allSettled(this.activeTasks.values())
  }

  private async executeRun(run: WorkflowRun, signal: AbortSignal, owner: RunOwnership, resumeCommand?: Command): Promise<void> {
    const startedAt = run.startedAt ?? new Date().toISOString()
    const failedNodes = new AbortController()
    const nodeSignal = AbortSignal.any([signal, failedNodes.signal])
    const activeNodes = new Set<Promise<Partial<EngineStateValue>>>()
    let firstFailure: { error: unknown } | undefined
    const drain = async () => {
      while (activeNodes.size) await Promise.allSettled([...activeNodes])
    }

    try {
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
      const builder = new StateGraph(EngineState) as unknown as DynamicGraphBuilder
      for (const node of version.definition.nodes) {
        builder.addNode(node.id, (state) => {
          const task = limiter.run(nodeSignal, () => this.executeNode(run, version, node.id, topology.incoming.get(node.id) ?? [], state, nodeSignal, owner))
          activeNodes.add(task)
          void task.then(
            () => { activeNodes.delete(task) },
            (error: unknown) => {
              firstFailure ??= { error }
              failedNodes.abort(error)
              activeNodes.delete(task)
            },
          )
          return task
        })
      }
      builder.addEdge(START, version.entryNodeId)
      for (const node of version.definition.nodes) {
        const sources = topology.incoming.get(node.id) ?? []
        if (sources.length === 1) builder.addEdge(sources[0] as string, node.id)
        if (sources.length > 1) builder.addEdge(sources, node.id)
      }
      for (const sink of topology.sinks) builder.addEdge(sink, END)

      const graph = builder.compile({ checkpointer: this.checkpointer })
      const graphConfig = { configurable: { thread_id: run.id } }
      const state = await graph.invoke(
        resumeCommand ?? { runId: run.id, executionIds: {} },
        graphConfig,
      )
      const snapshot = await graph.getState(graphConfig)
      const pendingInterrupts = snapshot.tasks.flatMap((task) => task.interrupts ?? [])
      if (pendingInterrupts.length) {
        if (!this.interactions) throw new DomainError('APPROVAL_RUNTIME_MISSING', 'The graph interrupted without an interaction repository.', 500)
        for (const pending of pendingInterrupts) {
          const value = pending.value as { interactionId?: unknown }
          if (typeof value?.interactionId !== 'string') throw new DomainError('GRAPH_INTERRUPT_INVALID', 'The graph interrupt has no interaction identity.', 500)
          await this.interactions.bindGraphInterrupt(value.interactionId, pending.id)
        }
        await this.runs.updateState(run.id, { executionState: 'waiting', outcome: 'pending', startedAt }, owner)
        return
      }
      signal.throwIfAborted()
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
        executionState: 'completed',
        outcome: 'succeeded',
        result,
        startedAt,
        finishedAt: new Date().toISOString(),
      }, owner)
    } catch (error) {
      failedNodes.abort(error)
      // LangGraph can reject before sibling harnesses finish. Retain both local
      // tracking and database ownership until every launched task cleans up.
      await drain()
      owner.assertOwned()
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
    if (!this.approvals) await this.runs.createExecution(execution, owner)
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

    if (this.approvals && run.approval) {
      const observation = await this.approvals.ensureObserve({
        candidate: execution, request, approval: run.approval, workflowId: run.workflowId,
        graphThreadId: run.id, owner,
      })
      execution = observation.execution
      if (observation.state === 'waiting') {
        interrupt({ interactionId: observation.interaction.id })
        throw new DomainError('GRAPH_INTERRUPT_RESUME_MISSING', 'LangGraph returned from interrupt without a resume value.', 500)
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

    const adapter = this.harnesses.resolve(configuration.harness.harness)
    try {
      signal.throwIfAborted()
      owner.assertOwned()
      const result = await adapter.execute(request, {
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
