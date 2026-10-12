import type { RepeatGraphCurrentV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

type ExecutionFact = RepeatGraphCurrentV3['state']['executions'][number]
type ResolutionFact = RepeatGraphCurrentV3['state']['resolutions'][number]
/** Display-only input. The current query validates the complete canonical cut. */
export type PinnedNodeDisplayCut = { state: {
  executions: readonly (Pick<ExecutionFact, 'identity' | 'state' | 'resultOutcome'> & Partial<Pick<ExecutionFact, 'tickIndex'>>)[]
  resolutions: readonly { ref: Pick<ResolutionFact['ref'], 'nodeId' | 'occurrence'>;
    value: Pick<ResolutionFact['value'], 'resolution'|'execution'|'outcome'> }[]
} }

/** Linear in the bounded current cut; never scan all executions per canvas node.
 * This is only a display projection, not Run history or a scheduling decision. */
export function pinnedNodeStates(record?: PinnedNodeDisplayCut) {
  const states = new Map<string, { label: string; occurrenceIndex: number; attempt: number;jobOutcome?:string }>()
  if (!record) return states
  for (const resolution of record.state.resolutions) {
    const index = resolution.ref.occurrence?.occurrenceIndex ?? 0
    const previous = states.get(resolution.ref.nodeId)
    if (!previous || previous.occurrenceIndex <= index) states.set(resolution.ref.nodeId, {
      label: resolution.value.resolution, occurrenceIndex: index, attempt: 0, ...('execution' in resolution.value && resolution.value.execution?.kind==='job'&&resolution.value.outcome?{jobOutcome:resolution.value.outcome}:{}),
    })
  }
  for (const fact of record.state.executions) {
    if (fact.tickIndex) continue // An interval check is not the node's graph state.
    const id = fact.identity, index = id.occurrence?.occurrenceIndex ?? 0
    const previous = states.get(id.workflowNodeId)
    if (!previous || index > previous.occurrenceIndex || index === previous.occurrenceIndex && id.attempt >= previous.attempt) {
      states.set(id.workflowNodeId, { label: fact.state === 'completed' ? fact.resultOutcome ?? 'unknown' : fact.state,
        occurrenceIndex: index, attempt: id.attempt,...(id.kind==='job'&&previous?.occurrenceIndex===index&&previous.jobOutcome?{jobOutcome:previous.jobOutcome}:{}) })
    }
  }
  return states
}
export function pinnedTopology(version: WorkflowVersionV3) {
  const blocks = new Map(version.definition.repeat?.blocks.flatMap((block) =>
    block.nodeIds.map((nodeId) => [nodeId, block.id] as const)) ?? [])
  return {
    nodes: version.definition.nodes.map((node,index)=>{
      const common={id:node.id,label:node.name??node.label??node.id,entry:node.id===version.entryNodeId,blockId:blocks.get(node.id),position:node.position??{x:(index%4)*300,y:Math.floor(index/4)*200}}
      return node.kind==='job'?{...common,kind:'job' as const,jobDefinitionId:node.jobDefinitionId,jobDefinitionRevision:node.jobDefinitionRevision,jobDefinitionVersionId:node.jobDefinitionVersionId}:{...common,kind:'agent' as const,agentId:node.agentId,configurationId:version.agentConfigurationVersionIds[node.agentId]!,intervalSeconds:node.interval?.everySeconds}
    }),
    edges: version.definition.edges,
  }
}
