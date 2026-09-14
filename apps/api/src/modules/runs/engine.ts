import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import {
  HarnessExecutionRequestSchema,
  HarnessExecutionSchema,
  HarnessNativeEventSchema,
  type ExecutionResult,
  type WorkflowRun,
  type WorkflowVersion,
} from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import type { HarnessResolver, NativeEventInput } from '../harnesses/port.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { WorkflowOrchestrator } from './port.js'
import type { PostgresRunRepository } from './postgres.js'
import { validateExecutableTopology } from './topology.js'

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
    input: EngineStateValue,
    config: { configurable: { thread_id: string } },
  ): Promise<EngineStateValue>
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

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly harnesses: HarnessResolver,
    private readonly checkpointer: BaseCheckpointSaver,
    workspaceRoot: string,
    private readonly timeoutMs: number,
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
  }

  start(runId: string): Promise<void> {
    const existing = this.activeTasks.get(runId)
    if (existing) return existing
    const task = this.startRun(runId).finally(() => {
      this.activeRuns.delete(runId)
      this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  private async startRun(runId: string): Promise<void> {
    const run = await this.runs.get(runId)
    if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
    if (run.executionState !== 'queued') {
      throw new DomainError('RUN_NOT_STARTABLE', `Run '${runId}' is not queued.`, 409)
    }
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    timeout.unref()

    try {
      await this.executeRun(run, controller.signal)
    } finally {
      clearTimeout(timeout)
    }
  }

  async resume(runId: string): Promise<void> {
    throw new DomainError('RUN_RESUME_NOT_IMPLEMENTED', `Run '${runId}' cannot yet be resumed through the product API.`, 501)
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.activeRuns.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async shutdown(): Promise<void> {
    for (const controller of this.activeRuns.values()) controller.abort()
    await Promise.allSettled(this.activeTasks.values())
  }

  private async executeRun(run: WorkflowRun, signal: AbortSignal): Promise<void> {
    const startedAt = new Date().toISOString()
    await this.runs.updateState(run.id, { executionState: 'running', outcome: 'pending', startedAt })

    try {
      const version = await this.workflows.getVersion(run.workflowVersionId)
      if (!version) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', `Workflow version '${run.workflowVersionId}' was not found.`, 409)
      const topology = validateExecutableTopology(version)
      const builder = new StateGraph(EngineState) as unknown as DynamicGraphBuilder
      for (const node of version.definition.nodes) {
        builder.addNode(node.id, async (state) => this.executeNode(run, version, node.id, topology.incoming.get(node.id) ?? [], state, signal))
      }
      builder.addEdge(START, version.entryNodeId)
      for (const node of version.definition.nodes) {
        const sources = topology.incoming.get(node.id) ?? []
        if (sources.length === 1) builder.addEdge(sources[0] as string, node.id)
        if (sources.length > 1) builder.addEdge(sources, node.id)
      }
      for (const sink of topology.sinks) builder.addEdge(sink, END)

      const graph = builder.compile({ checkpointer: this.checkpointer })
      const state = await graph.invoke(
        { runId: run.id, executionIds: {} },
        { configurable: { thread_id: run.id } },
      )
      const finalOutputs = await Promise.all(topology.sinks.map(async (nodeId) => {
        const executionId = state.executionIds[nodeId]
        if (!executionId) throw new DomainError('FINAL_EXECUTION_MISSING', `Final node '${nodeId}' did not produce an execution.`, 500)
        const result = await this.runs.getAcceptedResult(executionId)
        if (!result) throw new DomainError('FINAL_RESULT_MISSING', `Final node '${nodeId}' has no accepted result.`, 500)
        return { nodeId, executionId, result: result.output ?? null }
      }))
      const result: ExecutionResult = {
        outcome: 'succeeded',
        output: finalOutputs.length === 1 ? finalOutputs[0]?.result ?? null : { outputs: finalOutputs },
      }
      await this.runs.updateState(run.id, {
        executionState: 'completed',
        outcome: 'succeeded',
        result,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    } catch (error) {
      const result = failedResult(error, signal.aborted)
      await this.runs.updateState(run.id, {
        executionState: 'completed',
        outcome: result.outcome,
        result,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    }
  }

  private async executeNode(
    run: WorkflowRun,
    version: WorkflowVersion,
    nodeId: string,
    predecessorNodeIds: string[],
    state: EngineStateValue,
    signal: AbortSignal,
  ): Promise<Partial<EngineStateValue>> {
    if (signal.aborted) throw new HarnessExecutionError('EXECUTION_CANCELED', 'The workflow run was canceled.')
    const node = version.definition.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', `Node '${nodeId}' was not found.`, 500)
    const configurationVersionId = run.agentConfigurationVersionIds[node.agentId]
    if (!configurationVersionId) throw new DomainError('AGENT_CONFIGURATION_NOT_PINNED', `Agent '${node.agentId}' has no pinned configuration.`, 500)
    const configuration = await this.workflows.getAgentConfiguration(configurationVersionId)
    if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', `Configuration '${configurationVersionId}' was not found.`, 500)

    const predecessorResults = await Promise.all(predecessorNodeIds.map(async (predecessorNodeId) => {
      const executionId = state.executionIds[predecessorNodeId]
      if (!executionId) throw new DomainError('HANDOFF_EXECUTION_MISSING', `Dependency '${predecessorNodeId}' has no execution.`, 500)
      const accepted = await this.runs.getAcceptedResult(executionId)
      if (!accepted) throw new DomainError('HANDOFF_RESULT_MISSING', `Dependency execution '${executionId}' has no accepted result.`, 500)
      return { predecessorNodeId, executionId, result: accepted.output ?? null }
    }))
    const input = predecessorResults.length === 0
      ? run.input
      : predecessorResults.length === 1
        ? { previous: predecessorResults[0] }
        : { predecessors: predecessorResults }
    const executionId = `execution-${randomUUID()}`
    const workingDirectory = this.executionDirectory(run.id, nodeId, 1)
    await mkdir(workingDirectory, { recursive: true })
    const now = new Date().toISOString()
    let execution = HarnessExecutionSchema.parse({
      id: executionId,
      runId: run.id,
      workflowNodeId: nodeId,
      agentId: node.agentId,
      agentConfigurationVersionId: configurationVersionId,
      attempt: 1,
      input,
      state: 'starting',
      createdAt: now,
      startedAt: now,
    })
    await this.runs.createExecution(execution)
    const request = HarnessExecutionRequestSchema.parse({
      executionId,
      runId: run.id,
      workspaceId: run.workspaceId,
      workflowNodeId: nodeId,
      workingDirectory,
      configuration,
      input,
    })
    const adapter = this.harnesses.resolve(configuration.harness.harness)
    let eventSequence = 0

    try {
      const result = await adapter.execute(request, {
        signal,
        onSession: async (nativeSessionId) => {
          execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId, state: 'running' })
          await this.runs.updateExecution(execution)
          await this.runs.recordActivity(run.id, 'harness', 'harness_session_started', {
            workflowNodeId: nodeId,
            agentId: node.agentId,
            nativeSessionId,
            harness: configuration.harness.harness,
          }, executionId)
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
          await this.runs.appendNativeEvent(nativeEvent)
        },
      })
      execution = HarnessExecutionSchema.parse({
        ...execution,
        state: 'completed',
        result,
        finishedAt: new Date().toISOString(),
      })
      await this.runs.acceptExecutionResult(execution)
      await this.runs.recordActivity(run.id, 'harness', 'harness_session_finished', {
        workflowNodeId: nodeId,
        outcome: result.outcome,
      }, executionId)
      return { executionIds: { [nodeId]: executionId } }
    } catch (error) {
      const result = failedResult(error, signal.aborted)
      execution = HarnessExecutionSchema.parse({
        ...execution,
        state: 'completed',
        result,
        finishedAt: new Date().toISOString(),
      })
      await this.runs.updateExecution(execution)
      await this.runs.recordActivity(run.id, 'harness', 'harness_session_finished', {
        workflowNodeId: nodeId,
        outcome: result.outcome,
        error: result.error ?? null,
      }, executionId)
      throw error
    }
  }

  private executionDirectory(runId: string, nodeId: string, attempt: number): string {
    const directory = resolve(this.workspaceRoot, runId, nodeId, `attempt-${attempt}`)
    if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new DomainError('HARNESS_WORKSPACE_INVALID', 'Harness workspace escaped its configured root.', 500)
    }
    return directory
  }
}
