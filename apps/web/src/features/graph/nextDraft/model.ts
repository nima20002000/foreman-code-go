import type { z } from 'zod'
import { addAgentOperations, configureAgentOperations, type DraftAgentEdits } from './agentEdits'
import type { Agent, WorkflowApprovalConfiguration } from '@graphql/contracts'
import type { ManagedAgentSchema } from '@graphql/contracts/management'
import type { GraphDraftOperationV2, GraphDraftV2, WorkflowDefinitionV2, WorkflowRelationship } from '@graphql/contracts/wave25'

export type CatalogAgent = z.infer<typeof ManagedAgentSchema>
export type NextDraftContext = { draft: GraphDraftV2; agents: CatalogAgent[] }
export type DraftNode = WorkflowDefinitionV2['nodes'][number]
export type AuthoringIssue = { code: string; message: string; nodeId?: string; relationshipId?: string }
export type RoleEvidence = {
  role?: 'orchestrator' | 'coder'
  configurationVersionId?: string
  source: 'configuration' | 'staged' | 'unavailable'
}

/** JSON content comparison, not a new workflow validation or runtime authority. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).filter((key) => a[key] !== undefined)
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length
    && keys.every((key) => sameValue(a[key], b[key]))
}

export function draftAgents(context: NextDraftContext): Agent[] {
  const agents = new Map(context.agents.map(({ agent }) => [agent.id, agent]))
  for (const staged of context.draft.stagedAgents) agents.set(staged.agent.id, staged.agent)
  return [...agents.values()]
}

/** Only server-returned productRole/configuration pins, never Agent.role or node labels. */
export function roleEvidence(context: NextDraftContext, agentId: string): RoleEvidence {
  const staged = context.draft.stagedAgents.find((item) => item.agent.id === agentId)
  const agent = staged?.agent ?? context.agents.find((item) => item.agent.id === agentId)?.agent
  const expected = context.draft.sourceAgentPins?.find((pin) => pin.agentId === agentId)
  if (!agent || (!staged && (!agent.configurationVersionId
    || (expected && expected.configurationVersionId !== agent.configurationVersionId)))) return { source: 'unavailable' }
  const role = agent.productRole
  if (role !== 'orchestrator' && role !== 'coder') return { source: 'unavailable' }
  return { role, source: staged ? 'staged' : 'configuration', configurationVersionId: agent.configurationVersionId }
}

export function entryChoices(graph: WorkflowDefinitionV2, context: NextDraftContext) {
  const roles = new Map(graph.nodes.map((node) => [node.id, roleEvidence(context, node.agentId)]))
  const unresolved = graph.nodes.filter((node) => !roles.get(node.id)?.role)
  const orchestrators = graph.nodes.filter((node) => roles.get(node.id)?.role === 'orchestrator')
  // An unresolved node might be an Orchestrator. Do not enable a permissive Worker fallback.
  const eligible = unresolved.length ? [] : orchestrators.length ? orchestrators : graph.nodes.filter((node) => roles.get(node.id)?.role === 'coder')
  return { roles, unresolved, eligible,
    valid: graph.entryNodeId !== null && eligible.some((node) => node.id === graph.entryNodeId),
    mode: graph.nodes.length === 1 ? 'sole' : orchestrators.length ? 'orchestrator' : 'worker',
  }
}

export function nodeTitle(graph: WorkflowDefinitionV2, id: string): string {
  const node = graph.nodes.find((item) => item.id === id)
  return node?.name ?? node?.label ?? `Missing node (${id})`
}

/** Hints explain frozen acceptance rules. Only the shared service can accept a version. */
export function authoringHints(graph: WorkflowDefinitionV2, context: NextDraftContext): AuthoringIssue[] {
  const issues: AuthoringIssue[] = []
  const entry = entryChoices(graph, context)
  if (!graph.nodes.length) issues.push({ code: 'ENTRY_REQUIRED', message: 'Add a board Agent before selecting an entry.' })
  else if (entry.unresolved.length) issues.push({ code: 'ROLE_PIN_UNAVAILABLE', message: 'A product-role pin is unavailable or changed. Reload the Agent context; labels cannot determine entry.' })
  else if (!entry.valid) issues.push({ code: 'ENTRY_REQUIRED', message: entry.mode === 'sole'
    ? 'The sole node must be the explicit entry.'
    : entry.mode === 'orchestrator' ? 'Select an Orchestrator as entry. Reordering does not change entry.'
      : 'Select a Worker as entry. Reordering does not change entry.' })
  for (const edge of graph.edges) {
    if (edge.kind === 'execution' && edge.target === graph.entryNodeId) issues.push({
      code: 'ENTRY_HAS_DEPENDENCY', relationshipId: edge.id, message: 'Entry cannot have an incoming execution dependency. Remove or redirect this execution record.',
    })
  }
  for (const node of graph.nodes) {
    if (!node.choice) continue
    if (!node.choice.outcomes.length) issues.push({ code: 'CHOICE_INCOMPLETE', nodeId: node.id, message: 'Declare at least one outcome and choose an execution edge or an explicit branch end.' })
    const declared = new Set<string>()
    const targets = new Set<string>()
    for (const item of node.choice.outcomes) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(item.outcome) || declared.has(item.outcome)) issues.push({ code: 'OUTCOME_INVALID', nodeId: node.id, message: 'Outcome names must be unique: a lowercase letter, then lowercase letters, digits or underscores (48 characters maximum).' })
      declared.add(item.outcome)
      if (item.target.kind === 'edge') {
        targets.add(item.target.relationshipId)
        if (!graph.edges.some((edge) => item.target.kind === 'edge' && edge.id === item.target.relationshipId && edge.kind === 'execution' && edge.source === node.id)) issues.push({
          code: 'CHOICE_TARGET_REQUIRED', nodeId: node.id, relationshipId: item.target.relationshipId,
          message: 'Choose an existing outgoing execution record or explicitly end this branch. A missing edge is not a branch end.',
        })
      }
    }
    if (node.choice.outcomes.length > 16) issues.push({ code: 'CHOICE_TOO_LARGE', nodeId: node.id, message: 'A choice supports at most 16 declared outcomes.' })
    for (const edge of graph.edges) if (edge.kind === 'execution' && edge.source === node.id && !targets.has(edge.id)) issues.push({
      code: 'UNDECLARED_CHOICE_EDGE', nodeId: node.id, relationshipId: edge.id, message: 'Each outgoing choice edge needs a declared outcome. Ordinary fan-out is a separate mode.',
    })
  }
  const approvals = graph.edges.filter((edge) => edge.kind === 'approval')
  if (!graph.approval) issues.push({ code: 'APPROVAL_MODE_REQUIRED', message: 'Select an explicit approval handler before saving an executable version.' })
  if (graph.approval?.handler !== 'orchestrator' && approvals.length) issues.push({ code: 'APPROVAL_MODE_CONFLICT', message: 'Human/Operator handling cannot include App reviewer assignments. Remove those records explicitly before switching authority.' })
  if (graph.approval?.handler === 'orchestrator') {
    const reviewer = graph.nodes.find((node) => node.agentId === graph.approval?.designatedOrchestratorAgentId)
    if (!reviewer || reviewer.id !== graph.entryNodeId || entry.roles.get(reviewer.id)?.role !== 'orchestrator') issues.push({
      code: 'REVIEWER_BOOTSTRAP_UNSUPPORTED', message: 'Executable save supports one initialized reviewer: the explicitly designated entry Orchestrator.',
    })
    if (approvals.some((edge) => edge.source !== graph.entryNodeId || edge.target === graph.entryNodeId)) issues.push({
      code: 'REVIEWER_BOOTSTRAP_UNSUPPORTED', message: 'These assignments require independent or nested reviewer startup. They may be draftable, but executable save does not support them.',
    })
  }
  return issues
}

export function removeRelationship(graph: WorkflowDefinitionV2, relationshipId: string): WorkflowDefinitionV2 {
  const edges = graph.edges.filter((edge) => edge.id !== relationshipId)
  // Deliberately retain now-incomplete choice references. Do not invent a branch end.
  return edges.length === graph.edges.length ? graph : { ...graph, edges }
}

export function removeNode(graph: WorkflowDefinitionV2, nodeId: string): WorkflowDefinitionV2 {
  if (!graph.nodes.some((node) => node.id === nodeId)) return graph
  return { ...graph, nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    entryNodeId: graph.entryNodeId === nodeId ? null : graph.entryNodeId }
}

export function putRelationship(graph: WorkflowDefinitionV2, relationship: WorkflowRelationship): WorkflowDefinitionV2 {
  const previous = graph.edges.find((edge) => edge.id === relationship.id)
  if (previous && previous.kind !== relationship.kind) throw new Error('A relationship identity cannot change meaning. Remove that record and create a new one.')
  if (relationship.source === relationship.target || ![relationship.source, relationship.target].every((id) => graph.nodes.some((node) => node.id === id))) throw new Error('Choose distinct existing endpoints.')
  if (relationship.kind === 'approval' && graph.edges.some((edge) => edge.kind === 'approval' && edge.target === relationship.target && edge.id !== relationship.id)) throw new Error('A requester can have only one App reviewer. Edit its existing approval record.')
  if (previous && sameValue(previous, relationship)) return graph
  return { ...graph, edges: previous ? graph.edges.map((edge) => edge.id === relationship.id ? relationship : edge) : [...graph.edges, relationship] }
}

export function changeApprovalHandler(graph: WorkflowDefinitionV2, handler: WorkflowApprovalConfiguration['handler']): WorkflowDefinitionV2 {
  if (handler !== 'orchestrator' && graph.edges.some((edge) => edge.kind === 'approval')) throw new Error('Remove approval assignments individually before switching handler. Execution routes will be preserved.')
  return { ...graph, approval: handler === 'orchestrator' && graph.approval?.handler === handler ? graph.approval : { handler } }
}

export function attachAgent(graph: WorkflowDefinitionV2, record: CatalogAgent, nodeId: string): WorkflowDefinitionV2 {
  if (record.archivedAt || !record.agent.configurationVersionId || !['coder', 'orchestrator'].includes(record.agent.productRole ?? '')) throw new Error('A board Agent with an available product-role configuration pin is required.')
  if (graph.nodes.some((node) => node.agentId === record.agent.id || node.id === nodeId)) throw new Error('An Agent can occur only once in this one-shot board.')
  const node: DraftNode = { id: nodeId, agentId: record.agent.id, name: record.agent.name,
    position: { x: 80 + (graph.nodes.length % 4) * 280, y: 80 + Math.floor(graph.nodes.length / 4) * 180 } }
  return { ...graph, nodes: [...graph.nodes, node], entryNodeId: graph.nodes.length === 0 ? nodeId : graph.entryNodeId }
}

/** IDs/kinds/directions survive visual pair inspection; this does not coalesce records. */
export function relationshipPairs(graph: WorkflowDefinitionV2): WorkflowRelationship[][] {
  const pairs = new Map<string, WorkflowRelationship[]>()
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.source, edge.target].sort())
    const pair = pairs.get(key) ?? []
    pair.push(edge); pairs.set(key, pair)
  }
  return [...pairs.values()]
}

/** Generate only the frozen v2 and legacy-safe operations, retaining exact revision/source pins. */
export function draftOperations(context: NextDraftContext, graph: WorkflowDefinitionV2, agentEdits: DraftAgentEdits = {}): GraphDraftOperationV2[] {
  const base = context.draft.graph
  if (base.id !== graph.id || base.workspaceId !== graph.workspaceId) throw new Error('Draft scope changed; reload this workspace.')
  const operations: GraphDraftOperationV2[] = []
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const oldNodes = new Map(base.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  for (const edge of base.edges) if (!edges.has(edge.id)) operations.push({ type: 'edge.disconnect', edgeId: edge.id })
  for (const node of base.nodes) if (!nodes.has(node.id)) operations.push({ type: 'node.remove', nodeId: node.id })
  for (const node of graph.nodes) {
    const old = oldNodes.get(node.id)
    if (old && old.agentId !== node.agentId) throw new Error('Node identity cannot be rebound to another Agent.')
    if (!old) {
      const source = context.agents.find((item) => item.agent.id === node.agentId)
      const local = agentEdits[node.agentId]
      if (!source && local) operations.push(...addAgentOperations(local, node))
      else {
        if (!source?.agent.configurationVersionId || source.archivedAt) throw new Error('The selected Agent source pin is unavailable. Reload before attaching it.')
        operations.push({ type: 'agent.attach', agentId: node.agentId, nodeId: node.id,
          expectedAgentRevision: source.metadataRevision, expectedConfigurationVersionId: source.agent.configurationVersionId,
          name: node.name ?? node.label, ...(node.position ? { position: node.position } : {}) })
      }
      operations.push({ type: 'node.replace_v2', node })
    } else if (!sameValue(old, node)) {
      const { choice: oldChoice, ...oldMetadata } = old
      const { choice, ...metadata } = node
      if (sameValue(oldMetadata, metadata)) operations.push({ type: 'node.set_choice', nodeId: node.id, choice: choice ?? null })
      else operations.push({ type: 'node.replace_v2', node })
      // Keep the destructured prior choice explicit: it is not copied into a new result.
      void oldChoice
    }
  }
  operations.push(...configureAgentOperations(context, graph, agentEdits))
  if (!sameValue(base.nodes.map((node) => node.id), graph.nodes.map((node) => node.id))) operations.push({ type: 'nodes.reorder', nodeIds: graph.nodes.map((node) => node.id) })
  if (!sameValue(base.approval, graph.approval)) {
    if (!graph.approval) throw new Error('Choose an explicit approval handler; clearing authority is unsupported.')
    if (graph.approval.handler !== 'orchestrator' && graph.edges.some((edge) => edge.kind === 'approval')) throw new Error('Remove approval records before changing handler.')
    operations.push({ type: 'workflow.set_approval', approval: graph.approval })
  }
  const oldEdges = new Map(base.edges.map((edge) => [edge.id, edge]))
  for (const edge of graph.edges) {
    const old = oldEdges.get(edge.id)
    if (old && old.kind !== edge.kind) throw new Error('A relationship ID cannot be reused for another meaning.')
    if (!sameValue(old, edge)) operations.push({ type: 'relationship.put', relationship: edge })
  }
  if (!sameValue(base.edges, graph.edges)) operations.push({ type: 'edges.reorder', edgeIds: graph.edges.map((edge) => edge.id) })
  if (base.entryNodeId !== graph.entryNodeId) operations.push({ type: 'workflow.set_entry', entryNodeId: graph.entryNodeId })
  if (!sameValue(base.executionPolicy, graph.executionPolicy)) operations.push(graph.executionPolicy
    ? { type: 'workflow.set_execution_limits', ...graph.executionPolicy } : { type: 'workflow.reset_execution_limits' })
  if (base.requiredAgentCount !== graph.requiredAgentCount) operations.push(graph.requiredAgentCount !== undefined
    ? { type: 'workflow.set_required_agent_count', requiredAgentCount: graph.requiredAgentCount } : { type: 'workflow.reset_required_agent_count' })
  if (!sameValue(base.executionCondition, graph.executionCondition)) operations.push({ type: 'workflow.set_execution_condition', executionCondition: graph.executionCondition })
  return operations
}

function mergeFields<T extends object>(current: T, sent: T, saved: T): T {
  if (sameValue(current, sent)) return sameValue(current, saved) ? current : saved
  const next = { ...current } as Record<string, unknown>
  const a = current as Record<string, unknown>, b = sent as Record<string, unknown>, c = saved as Record<string, unknown>
  for (const key of new Set([...Object.keys(b), ...Object.keys(c)])) {
    if (!sameValue(a[key], b[key])) continue
    if (Object.hasOwn(c, key)) next[key] = c[key]
    else delete next[key]
  }
  return sameValue(current, next) ? current : next as T
}

/** An acknowledged own command can normalize its submission, never erase newer typing. */
export function mergeAcknowledgement(current: WorkflowDefinitionV2, sent: WorkflowDefinitionV2, saved: WorkflowDefinitionV2): WorkflowDefinitionV2 {
  if (sameValue(current, sent)) return sameValue(current, saved) ? current : saved
  const mergeEntities = <T extends { id: string }>(items: T[], before: T[], after: T[]): T[] => {
    const b = new Map(before.map((item) => [item.id, item])), a = new Map(after.map((item) => [item.id, item]))
    const merged = items.map((item) => b.has(item.id) && a.has(item.id) ? mergeFields(item, b.get(item.id)!, a.get(item.id)!) : item)
    return merged.every((item, index) => item === items[index]) ? items : merged
  }
  return { ...mergeFields(current, sent, saved), nodes: mergeEntities(current.nodes, sent.nodes, saved.nodes), edges: mergeEntities(current.edges, sent.edges, saved.edges) }
}

export function hasLocalChanges(context: NextDraftContext, graph: WorkflowDefinitionV2): boolean {
  const content = (value: WorkflowDefinitionV2) => {
    const { version, createdAt, updatedAt, ...editable } = value
    void version; void createdAt; void updatedAt
    return editable
  }
  return !sameValue(content(context.draft.graph), content(graph))
}
