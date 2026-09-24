import type { Agent, WorkflowDefinition, WorkflowNode } from '@graphql/contracts'
import type { GraphDraftOperation } from '@graphql/contracts/management'
import { sameManagedValue as same, type AgentRevisions, type CloneSources } from './managedGraphState'

function configuration(agent: Agent) {
  const value = agent.harnessConfiguration
  if (!value) throw new Error(`Agent '${agent.id}' needs its saved harness configuration. Reload it before saving these changes.`)
  return value
}
function content(agent: Agent) {
  return { prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [],
    description: agent.description ?? null, role: agent.role ?? null }
}
function settings(agent: Agent) {
  return { harnessConfiguration: agent.harnessConfiguration, harness: agent.harness, model: agent.model,
    effort: agent.effort, fastMode: agent.fastMode, ...content(agent) }
}
function sameNodeMeaning(before: WorkflowNode, after: WorkflowNode): boolean {
  return same({ ...before, position: undefined }, { ...after, position: undefined })
}
function unique(ids: readonly string[], kind: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`The graph contains duplicate ${kind} IDs.`)
}

/** Every editable field is transmitted or explicitly rejected; nothing is silently acknowledged. */
export function managementGraphOperations(input: {
  base: WorkflowDefinition; next: WorkflowDefinition
  baseAgents: readonly Agent[]; nextAgents: readonly Agent[]
  metadataRevisions: AgentRevisions; cloneSources?: CloneSources
}): GraphDraftOperation[] {
  if (input.base.id !== input.next.id || input.base.workspaceId !== input.next.workspaceId) throw new Error('The graph identity cannot change while saving.')
  if (!same(input.base.executionCondition, input.next.executionCondition)) throw new Error('Changing the execution condition is not supported by this editor.')
  unique(input.next.nodes.map((node) => node.id), 'node'); unique(input.next.edges.map((edge) => edge.id), 'edge')
  const operations: GraphDraftOperation[] = []
  const baseNodes = new Map(input.base.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(input.next.nodes.map((node) => [node.id, node]))
  const baseAgents = new Map(input.baseAgents.map((agent) => [agent.id, agent]))
  const nextAgents = new Map(input.nextAgents.map((agent) => [agent.id, agent]))
  const baseReferences = new Set(input.base.nodes.map((node) => node.agentId))
  const newNodes = input.next.nodes.filter((node) => !baseNodes.has(node.id))
  const newNodeByAgent = new Map(newNodes.map((node) => [node.agentId, node]))
  const creating = new Set<string>()
  const created = new Set<string>()

  const createNode = (node: WorkflowNode): void => {
    if (created.has(node.agentId)) {
      if (newNodeByAgent.get(node.agentId)?.id !== node.id) throw new Error('A second node for the same new agent needs an explicit clone.')
      return
    }
    if (creating.has(node.agentId)) throw new Error('The copied-agent sources form a cycle. Copy an original agent instead.')
    if (baseAgents.has(node.agentId)) throw new Error('Adding a node for an existing agent requires an explicit clone.')
    const agent = nextAgents.get(node.agentId)
    if (!agent) throw new Error(`Agent '${node.agentId}' is missing from the browser draft.`)
    creating.add(agent.id)
    const sourceId = input.cloneSources?.[agent.id]
    const localSourceNode = sourceId ? newNodeByAgent.get(sourceId) : undefined
    if (localSourceNode) createNode(localSourceNode)
    const canClone = sourceId && (baseReferences.has(sourceId) || created.has(sourceId))
    if (canClone) {
      const source = nextAgents.get(sourceId) ?? baseAgents.get(sourceId)
      if (!source) throw new Error('The copied source is unavailable. Reload and copy it again.')
      const sourceRevision = created.has(sourceId) ? null : input.metadataRevisions[sourceId]
      operations.push({
        type: 'agent.clone', sourceAgentId: sourceId, agentId: agent.id, nodeId: node.id, name: agent.name,
        ...(sourceRevision !== undefined ? { expectedSourceAgentRevision: sourceRevision } : {}),
        ...(created.has(sourceId) || sourceRevision === null
          ? { expectedSourceConfigurationVersionId: null }
          : source.configurationVersionId ? { expectedSourceConfigurationVersionId: source.configurationVersionId } : {}),
      })
      // Legacy projections without embedded configuration are cloned from the
      // server's pinned configuration, never reconstructed from global defaults.
      if (agent.harnessConfiguration) operations.push({ type: 'agent.configure', agentId: agent.id,
        expectedAgentRevision: 0, configuration: configuration(agent), ...content(agent) })
      else if (!same(settings(agent), settings(source))) {
        throw new Error('Reload the saved source configuration before changing the copied agent settings.')
      }
    } else {
      // A copied, unsaved source may have been deleted locally. Its complete
      // local snapshot is safe to create, but an incomplete legacy one is not.
      const harness = configuration(agent)
      operations.push({ type: 'agent.add', agentId: agent.id, nodeId: node.id, name: agent.name, productRole: agent.productRole ?? 'coder', harness: harness.harness, configuration: harness })
      operations.push({ type: 'agent.configure', agentId: agent.id, expectedAgentRevision: 0,
        configuration: harness, ...content(agent) })
    }
    operations.push({ type: 'node.replace', node })
    creating.delete(agent.id); created.add(agent.id)
  }
  for (const node of newNodes) createNode(node)

  for (const agentId of new Set(input.next.nodes.map((node) => node.agentId))) {
    const before = baseAgents.get(agentId); const after = nextAgents.get(agentId)
    if (!before || !after) continue
    const changedSettings = !same(settings(before), settings(after))
    const revision = input.metadataRevisions[agentId]
    if (revision === undefined && (before.name !== after.name || changedSettings)) throw new Error(`Agent '${agentId}' metadata revision is unavailable.`)
    if (before.name !== after.name) operations.push({ type: 'agent.rename', agentId, expectedAgentRevision: revision ?? 0, name: after.name })
    if (changedSettings) operations.push({ type: 'agent.configure', agentId, expectedAgentRevision: revision ?? 0,
      configuration: configuration(after), ...content(after) })
  }

  const nextEdges = new Map(input.next.edges.map((edge) => [edge.id, edge]))
  const baseEdges = new Map(input.base.edges.map((edge) => [edge.id, edge]))
  // Disconnect changed endpoints before reconnecting any, including endpoint swaps.
  for (const edge of input.base.edges) if (!same(edge, nextEdges.get(edge.id))) operations.push({ type: 'edge.disconnect', edgeId: edge.id })
  for (const node of input.base.nodes) if (!nextNodes.has(node.id)) operations.push({ type: 'node.remove', nodeId: node.id })
  for (const node of input.next.nodes) {
    const before = baseNodes.get(node.id)
    if (!before) continue
    if (before.agentId !== node.agentId) throw new Error('Changing a node agent requires an explicit clone.')
    if (!sameNodeMeaning(before, node)) operations.push({ type: 'node.replace', node })
  }
  for (const edge of input.next.edges) {
    if (!nextNodes.has(edge.source) || !nextNodes.has(edge.target)) throw new Error('An edge references a node that is not in the graph.')
    if (!same(edge, baseEdges.get(edge.id))) operations.push({ type: 'edge.put', edge })
  }
  if (!same(input.base.nodes.map((node) => node.id), input.next.nodes.map((node) => node.id))) {
    operations.push({ type: 'nodes.reorder', nodeIds: input.next.nodes.map((node) => node.id) })
  }
  if (!same(input.base.edges, input.next.edges)) operations.push({ type: 'edges.reorder', edgeIds: input.next.edges.map((edge) => edge.id) })
  if (!same(input.base.executionPolicy, input.next.executionPolicy)) operations.push(input.next.executionPolicy
    ? { type: 'workflow.set_execution_limits', ...input.next.executionPolicy }
    : { type: 'workflow.reset_execution_limits' })
  if (input.base.requiredAgentCount !== input.next.requiredAgentCount) operations.push(
    input.next.requiredAgentCount === undefined
      ? { type: 'workflow.reset_required_agent_count' }
      : { type: 'workflow.set_required_agent_count', requiredAgentCount: input.next.requiredAgentCount },
  )
  if (!same(input.base.approval, input.next.approval)) {
    if (!input.next.approval) throw new Error('Choose an approval handler instead of removing the workflow approval configuration.')
    operations.push({ type: 'workflow.set_approval', approval: input.next.approval })
  }
  return operations
}
