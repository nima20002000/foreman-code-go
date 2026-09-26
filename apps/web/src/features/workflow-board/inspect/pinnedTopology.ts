import type { RepeatGraphCurrentV3, WorkflowVersionV3 } from '@graphql/contracts/wave25'

type ExecutionFact = RepeatGraphCurrentV3['state']['executions'][number]
type ResolutionFact = RepeatGraphCurrentV3['state']['resolutions'][number]
/** Display-only input. The current query validates the complete canonical cut. */
export type PinnedNodeDisplayCut = { state: {
  executions: readonly Pick<ExecutionFact, 'identity' | 'state' | 'resultOutcome'>[]
  resolutions: readonly { ref: Pick<ResolutionFact['ref'], 'nodeId' | 'occurrence'>;
    value: Pick<ResolutionFact['value'], 'resolution'> }[]
} }

/** Linear in the bounded current cut; never scan all executions per canvas node.
 * This is only a display projection, not Run history or a scheduling decision. */
export function pinnedNodeStates(record?: PinnedNodeDisplayCut) {
  const states = new Map<string, { label: string; occurrenceIndex: number; attempt: number }>()
  if (!record) return states
  for (const resolution of record.state.resolutions) {
    const index = resolution.ref.occurrence?.occurrenceIndex ?? 0
    const previous = states.get(resolution.ref.nodeId)
    if (!previous || previous.occurrenceIndex <= index) states.set(resolution.ref.nodeId, {
      label: resolution.value.resolution, occurrenceIndex: index, attempt: 0,
    })
  }
  for (const fact of record.state.executions) {
    const id = fact.identity, index = id.occurrence?.occurrenceIndex ?? 0
    const previous = states.get(id.workflowNodeId)
    if (!previous || index > previous.occurrenceIndex || index === previous.occurrenceIndex && id.attempt >= previous.attempt) {
      states.set(id.workflowNodeId, { label: fact.state === 'completed' ? fact.resultOutcome ?? 'unknown' : fact.state,
        occurrenceIndex: index, attempt: id.attempt })
    }
  }
  return states
}
export function pinnedTopology(version: WorkflowVersionV3) {
  const blocks = new Map(version.definition.repeat?.blocks.flatMap((block) =>
    block.nodeIds.map((nodeId) => [nodeId, block.id] as const)) ?? [])
  return {
    nodes: version.definition.nodes.map((node, index) => ({
      id: node.id, label: node.name ?? node.label ?? node.id, agentId: node.agentId,
      configurationId: version.agentConfigurationVersionIds[node.agentId]!,
      entry: node.id === version.entryNodeId, blockId: blocks.get(node.id),
      // A deterministic presentation position is not a historical execution fact.
      position: node.position ?? { x: (index % 4) * 300, y: Math.floor(index / 4) * 200 },
    })),
    edges: version.definition.edges,
  }
}
