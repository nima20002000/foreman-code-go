import { Annotation, END, START, StateGraph, type Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { WorkflowVersionV2 } from '@graphql/contracts/wave25'

import { ExecutionLimiter } from './limiter.js'
import { oneShotNodeAction, type OneShotExecutionDriver, type OneShotGraphState } from './oneShotNode.js'
import { compileOneShotTopology } from './topology.js'
import type { OneShotRunRepository } from './oneShotPostgres.js'

const OneShotState = Annotation.Root({
  runId: Annotation<string>(),
  executionIds: Annotation<Record<string, string>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
})

export interface OneShotCheckpoint {
  values: Partial<OneShotGraphState>
  next: string[]
  tasks: Array<{ name: string; error?: unknown; result?: unknown; interrupts?: Array<{ id: string; value: unknown }> }>
}
interface GraphBuilder {
  addNode(name: string, action: (state: OneShotGraphState) => Promise<Partial<OneShotGraphState>>): GraphBuilder
  addEdge(source: string | string[], target: string): GraphBuilder
  compile(options: { checkpointer: BaseCheckpointSaver }): {
    invoke(input: OneShotGraphState | Command | null, config: { configurable: { thread_id: string }; signal?: AbortSignal; recursionLimit: number }): Promise<OneShotGraphState>
    getState(config: { configurable: { thread_id: string } }): Promise<OneShotCheckpoint>
  }
}

/**
 * Keep LangGraph's one-shot barriers. Every static execution wrapper resolves,
 * including unselected branches, so unequal-depth joins cannot activate early.
 * Approval relationships are absent from this graph, not merely hidden visually.
 */
export function buildOneShotGraph(input: {
  runId: string
  version: WorkflowVersionV2
  store: Pick<OneShotRunRepository, 'admit' | 'acceptTerminal'>
  driver: OneShotExecutionDriver
  checkpointer: BaseCheckpointSaver
  signal: AbortSignal
  /** Service configuration, independent of board size. Review capacity is separate. */
  configuredParallelism?: number
  maximumWaiting?: number
  track?: (task: Promise<Partial<OneShotGraphState>>) => void
}) {
  const topology = compileOneShotTopology(input.version)
  const configured = input.configuredParallelism ?? 4
  if (!Number.isSafeInteger(configured) || configured < 1) throw new Error('INVALID_RUNNER_PARALLELISM')
  const configuredWait = input.maximumWaiting ?? 1000
  const parallelism = Math.min(configured, input.version.definition.executionPolicy!.maxParallelism)
  const action = oneShotNodeAction({ ...input, limiter: new ExecutionLimiter(parallelism, configuredWait) })
  const graph = compileOneShotGraph(input.version, input.checkpointer, (nodeId, state) => {
    const task = action(nodeId, state)
    input.track?.(task)
    return task
  })
  return { graph, config: { configurable: { thread_id: input.runId }, signal: input.signal, recursionLimit: topology.recursionLimit } }
}

export function compileOneShotGraph(version: WorkflowVersionV2, checkpointer: BaseCheckpointSaver,
  action: (nodeId: string, state: OneShotGraphState) => Promise<Partial<OneShotGraphState>>) {
  const topology = compileOneShotTopology(version)
  const builder = new StateGraph(OneShotState) as unknown as GraphBuilder
  for (const nodeId of topology.order) builder.addNode(nodeId, (state) => action(nodeId, state))
  builder.addEdge(START, topology.entryNodeId)
  for (const nodeId of topology.order) {
    // Multiple execution records between the same pair remain distinct input
    // receipts, but each predecessor wrapper participates in the barrier once.
    const sources = [...new Set(topology.incoming.get(nodeId)!.map((edge) => edge.source))]
    if (sources.length === 1) builder.addEdge(sources[0]!, nodeId)
    else if (sources.length > 1) builder.addEdge(sources, nodeId)
  }
  for (const sink of topology.sinks) builder.addEdge(sink, END)
  return builder.compile({ checkpointer })
}
