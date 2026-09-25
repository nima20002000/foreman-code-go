import { Annotation, END, START, StateGraph, type Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { RepeatWorkflowVersionV1Schema, type RepeatOccurrenceV1, type RepeatWorkflowVersionV1 } from '@graphql/contracts/wave25'

import { ExecutionLimiter } from './limiter.js'
import { repeatNodeAction, type RepeatExecutionDriver, type RepeatGraphState, type RepeatNodeStore } from './repeatNode.js'
import { compileRepeatLayout, repeatConflict } from './repeatResolution.js'
import type { RepeatRunRepository } from './repeatPostgres.js'

const RepeatState = Annotation.Root({
  runId: Annotation<string>(),
  occurrences: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  boundaries: Annotation<Record<string, 'body' | 'done'>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  executionIds: Annotation<RepeatGraphState['executionIds']>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
})
export interface RepeatCheckpoint {
  values: Partial<RepeatGraphState>
  next: string[]
  tasks: Array<{ name: string; error?: unknown; result?: unknown; interrupts?: Array<{ id: string; value: unknown }> }>
}
interface GraphBuilder {
  addNode(name: string, action: (state: RepeatGraphState) => Promise<Partial<RepeatGraphState>>): GraphBuilder
  addEdge(source: string | string[], target: string): GraphBuilder
  addConditionalEdges(source: string, path: (state: RepeatGraphState) => 'body' | 'done', mapping: Record<'body' | 'done', string>): GraphBuilder
  compile(options: { checkpointer: BaseCheckpointSaver }): {
    invoke(input: RepeatGraphState | Command | null, config: { configurable: { thread_id: string }; signal?: AbortSignal; recursionLimit: number }): Promise<RepeatGraphState>
    getState(config: { configurable: { thread_id: string } }): Promise<RepeatCheckpoint>
  }
}
export type RepeatGraphStore = RepeatNodeStore & Pick<RepeatRunRepository, 'enterBlock' | 'readOccurrence' | 'transition'>

/** One LangGraph and the same thread/checkpointer/interrupt coordinator. NOT one
 * graph per occurrence, a cap-sized unroll, an external scheduler or a new engine.
 * Internal barriers fire for skipped wrappers too. Only block.done can satisfy
 * an external barrier; intermediate exits cannot select OR deselect external edges.
 */
export function buildRepeatGraph(input: {
  runId: string; version: RepeatWorkflowVersionV1; store: RepeatGraphStore; driver: RepeatExecutionDriver
  checkpointer: BaseCheckpointSaver; signal: AbortSignal; configuredParallelism?: number; maximumWaiting?: number
  track?: (task: Promise<Partial<RepeatGraphState>>) => void
}) {
  const version = RepeatWorkflowVersionV1Schema.parse(input.version), layout = compileRepeatLayout(version)
  const configured = input.configuredParallelism ?? 4
  if (!Number.isSafeInteger(configured) || configured < 1) return repeatConflict('INVALID_RUNNER_PARALLELISM')
  const action = repeatNodeAction({ ...input, limiter: new ExecutionLimiter(
    Math.min(configured, version.definition.executionPolicy!.maxParallelism), input.maximumWaiting ?? 1000) })
  const graph = new StateGraph(RepeatState) as unknown as GraphBuilder
  const current = async (blockId: string, state: RepeatGraphState): Promise<RepeatOccurrenceV1> => {
    const id = state.occurrences[blockId]
    if (!id) return repeatConflict('REPEAT_CHECKPOINT_OCCURRENCE_MISSING')
    const value = await input.store.readOccurrence(id)
    if (value.identity.scope.runId !== input.runId || value.identity.scope.workflowVersionId !== version.id
      || value.identity.blockId !== blockId) return repeatConflict('REPEAT_CHECKPOINT_OCCURRENCE_CONFLICT')
    return value
  }
  for (const node of layout.nodes) graph.addNode(node.name, (state) => {
    const task = (async (): Promise<Partial<RepeatGraphState>> => {
      if (state.runId !== input.runId) return repeatConflict('RUN_PIN_CONFLICT')
      input.signal.throwIfAborted()
      if (node.kind === 'done') return {}
      if (node.kind === 'enter') {
        const admission = await input.store.enterBlock(node.blockId!)
        return admission.kind === 'inactive' ? { boundaries: { [node.blockId!]: 'done' } }
          : { occurrences: { [node.blockId!]: admission.occurrence.identity.occurrenceId }, boundaries: { [node.blockId!]: 'body' } }
      }
      if (node.kind === 'advance') {
        const occurrence = await current(node.blockId!, state)
        const transition = await input.store.transition(occurrence.identity.occurrenceId)
        return transition.next ? { occurrences: { [node.blockId!]: transition.next.identity.occurrenceId }, boundaries: { [node.blockId!]: 'body' } }
          : { boundaries: { [node.blockId!]: 'done' } }
      }
      const occurrence = node.kind === 'body' ? (await current(node.blockId!, state)).identity : null
      return action({ nodeId: node.nodeId, occurrence }, state)
    })()
    input.track?.(task)
    return task
  })
  graph.addEdge(START, layout.start)
  for (const edge of layout.edges) graph.addEdge(edge.sources.length === 1 ? edge.sources[0]! : edge.sources, edge.target)
  for (const boundary of layout.boundaries) {
    const route = (state: RepeatGraphState) => state.boundaries[boundary.blockId] ?? repeatConflict('REPEAT_BOUNDARY_UNRESOLVED')
    const mapping = { body: boundary.body, done: boundary.done }
    graph.addConditionalEdges(boundary.enter, route, mapping)
    graph.addConditionalEdges(boundary.advance, route, mapping)
  }
  for (const sink of layout.sinks) graph.addEdge(sink, END)
  return { graph: graph.compile({ checkpointer: input.checkpointer }),
    config: { configurable: { thread_id: input.runId }, signal: input.signal, recursionLimit: layout.recursionLimit } }
}
