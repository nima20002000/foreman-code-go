import type { Agent } from '@graphql/contracts'
import type { GraphDraftOperationV2, WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { draftAgents, sameValue, type DraftNode, type NextDraftContext } from './model'
import type { NextDraftEdit } from './state'

export type DraftAgentEdits = Record<string, Agent>
export function referencedAgentEdits(graph: WorkflowDefinitionV2, edits: DraftAgentEdits = {}): DraftAgentEdits {
  const ids = new Set(graph.nodes.map((node) => node.agentId))
  return Object.fromEntries(Object.entries(edits).filter(([id]) => ids.has(id)))
}
export function hasAgentEdits(edit: NextDraftEdit): boolean {
  return Object.keys(referencedAgentEdits(edit.graph, edit.agentEdits)).length > 0
}
export function editorAgents(edit: NextDraftEdit): Agent[] {
  return [...new Map([...draftAgents(edit.context), ...Object.values(edit.agentEdits ?? {})].map((agent) => [agent.id, agent])).values()]
}
function content(agent: Agent) {
  return { prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [], description: agent.description ?? null, role: agent.role ?? null }
}
function configuration(agent: Agent) {
  if (!agent.harnessConfiguration) throw new Error('Reload the complete Agent configuration before editing it.')
  return agent.harnessConfiguration
}
export function addAgentOperations(agent: Agent, node: DraftNode): GraphDraftOperationV2[] {
  const harness = configuration(agent)
  if (!agent.productRole) throw new Error('Select an explicit Agent product role.')
  return [
    { type: 'agent.add', agentId: agent.id, nodeId: node.id, name: agent.name, productRole: agent.productRole,
      harness: harness.harness, configuration: harness },
    { type: 'agent.configure', agentId: agent.id, expectedAgentRevision: 0, configuration: harness, ...content(agent) },
  ]
}
export function configureAgentOperations(context: NextDraftContext, graph: WorkflowDefinitionV2, edits: DraftAgentEdits): GraphDraftOperationV2[] {
  const operations: GraphDraftOperationV2[] = []
  for (const [id, after] of Object.entries(referencedAgentEdits(graph, edits))) {
    const staged = context.draft.stagedAgents.find((item) => item.agent.id === id)
    const source = context.agents.find((item) => item.agent.id === id)
    const before = staged?.agent ?? source?.agent
    if (!before) continue // Created explicitly by addAgentOperations in the same serial writer.
    if (before.productRole !== after.productRole) throw new Error('An existing Agent role cannot be rewritten by the board.')
    const revision = staged ? staged.baseRevision ?? 0 : source?.metadataRevision
    if (revision === undefined) throw new Error('The Agent revision is unavailable. Reload before editing its settings.')
    if (before.name !== after.name) operations.push({ type: 'agent.rename', agentId: id, expectedAgentRevision: revision, name: after.name })
    if (!sameValue({ configuration: before.harnessConfiguration, ...content(before) }, { configuration: after.harnessConfiguration, ...content(after) })) {
      operations.push({ type: 'agent.configure', agentId: id, expectedAgentRevision: revision, configuration: configuration(after), ...content(after) })
    }
  }
  return operations
}

/** Content-only edit. No server revision, configuration pin or pending receipt is invented. */
export function changeDraftAgent(edit: NextDraftEdit, agent: Agent, graph: WorkflowDefinitionV2): NextDraftEdit {
  if (edit.busy || edit.pending) throw new Error('Reconcile the pending draft command before editing Agent settings.')
  const before = editorAgents(edit).find((item) => item.id === agent.id)
  if (sameValue(before, agent) && sameValue(graph, edit.graph)) return edit
  const history = edit.agentHistory ?? edit.history.map(() => ({}))
  const edits = { ...edit.agentEdits, [agent.id]: agent }
  if (sameValue(draftAgents(edit.context).find((item) => item.id === agent.id), agent)) delete edits[agent.id]
  return { ...edit, graph, agentEdits: referencedAgentEdits(graph, edits),
    history: [...edit.history.slice(-49), edit.graph], agentHistory: [...history.slice(-49), edit.agentEdits ?? {}], validation: undefined }
}

/** Clear only the submitted Agent edits. Later edits survive normalization and publication. */
export function acknowledgeAgentEdits(current: DraftAgentEdits | undefined, sent: DraftAgentEdits | undefined, context: NextDraftContext): DraftAgentEdits | undefined {
  if (!current) return undefined
  const saved = new Map(draftAgents(context).map((agent) => [agent.id, agent]))
  return Object.fromEntries(Object.entries(current).flatMap(([id, agent]) => {
    const submitted = sent?.[id]
    if (!submitted) return [[id, agent]]
    if (sameValue(agent, submitted)) return []
    const acknowledged = saved.get(id)
    return [[id, acknowledged ? { ...agent, configurationVersionId: acknowledged.configurationVersionId,
      createdAt: acknowledged.createdAt, updatedAt: acknowledged.updatedAt } : agent]]
  }))
}
