import type { WorkflowVersion } from '@graphql/contracts'

import { DomainError } from '../errors.js'

export interface ExecutableTopology {
  incoming: Map<string, string[]>
  outgoing: Map<string, string[]>
  sinks: string[]
}

export function validateExecutableTopology(version: WorkflowVersion): ExecutableTopology {
  const nodeIds = new Set(version.definition.nodes.map((node) => node.id))
  const agentCount = new Set(version.definition.nodes.map((node) => node.agentId)).size
  if (version.definition.requiredAgentCount !== undefined && agentCount !== version.definition.requiredAgentCount) {
    throw new DomainError(
      'WORKFLOW_AGENT_COUNT_MISMATCH',
      `Workflow requires exactly ${version.definition.requiredAgentCount} agents but references ${agentCount}.`,
      409,
    )
  }
  const incoming = new Map([...nodeIds].map((nodeId) => [nodeId, [] as string[]]))
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, [] as string[]]))

  for (const edge of version.definition.edges) {
    const sources = incoming.get(edge.target)
    const targets = outgoing.get(edge.source)
    if (!sources || !targets) {
      throw new DomainError('WORKFLOW_EDGE_INVALID', `Edge '${edge.id}' references an unknown node.`, 409)
    }
    if (
      !edge.route
      || edge.route.outcomes.length !== 1
      || edge.route.outcomes[0] !== 'succeeded'
      || edge.route.result
      || edge.route.maxTraversals
    ) {
      throw new DomainError(
        'WORKFLOW_ROUTING_UNSUPPORTED',
        `Edge '${edge.id}' uses routing not supported by the first workflow engine.`,
        409,
      )
    }
    sources.push(edge.source)
    targets.push(edge.target)
  }

  for (const node of version.definition.nodes) {
    const sources = incoming.get(node.id)!
    if ((node.join && node.join.mode !== 'all') || (sources.length > 1 && !node.join)) {
      throw new DomainError(
        'WORKFLOW_JOIN_UNSUPPORTED',
        `Node '${node.id}' must use an all join; other join modes are not supported.`,
        409,
      )
    }
  }

  const reachable = new Set<string>()
  const queue = [version.entryNodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || reachable.has(current)) continue
    reachable.add(current)
    queue.push(...(outgoing.get(current) ?? []))
  }
  if (reachable.size !== nodeIds.size) {
    throw new DomainError('WORKFLOW_NODE_UNREACHABLE', 'Every workflow node must be reachable from the saved entry point.', 409)
  }

  const degrees = new Map([...incoming].map(([nodeId, sources]) => [nodeId, sources.length]))
  const topological = [...degrees].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId)
  let visited = 0
  while (topological.length > 0) {
    const current = topological.shift()
    if (!current) continue
    visited += 1
    for (const target of outgoing.get(current)!) {
      const degree = degrees.get(target)! - 1
      degrees.set(target, degree)
      if (degree === 0) topological.push(target)
    }
  }
  if (visited !== nodeIds.size) {
    throw new DomainError('WORKFLOW_REPEAT_UNSUPPORTED', 'Cycles and bounded repeats are not supported by the first workflow engine.', 409)
  }

  return {
    incoming,
    outgoing,
    sinks: [...outgoing].filter(([, targets]) => targets.length === 0).map(([nodeId]) => nodeId),
  }
}

/** Only v2 execution relationships participate in scheduling. Canvas order is not authority. */
export interface OneShotTopology {
  entryNodeId: string
  order: string[]
  excluded: string[]
  incoming: Map<string, import('@graphql/contracts/wave25').WorkflowRelationship[]>
  outgoing: Map<string, import('@graphql/contracts/wave25').WorkflowRelationship[]>
  sinks: string[]
  /** LangGraph supersteps, deliberately independent of the native execution budget. */
  recursionLimit: number
}

export function compileOneShotTopology(version: import('@graphql/contracts/wave25').WorkflowVersionV2): OneShotTopology {
  const nodes = new Set(version.definition.nodes.map((node) => node.id))
  if (!nodes.size || nodes.size !== version.definition.nodes.length || !nodes.has(version.entryNodeId)
    || version.definition.entryNodeId !== version.entryNodeId) {
    throw new DomainError('WORKFLOW_ENTRY_INVALID', 'The immutable version must pin an existing, authored entry.', 409)
  }
  const incoming: OneShotTopology['incoming'] = new Map([...nodes].map((id) => [id, []]))
  const outgoing: OneShotTopology['outgoing'] = new Map([...nodes].map((id) => [id, []]))
  const relationshipIds = new Set<string>()
  for (const edge of version.definition.edges) {
    if (relationshipIds.has(edge.id) || !nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) {
      throw new DomainError('WORKFLOW_EDGE_INVALID', `Relationship '${edge.id}' has invalid identity or endpoints.`, 409)
    }
    relationshipIds.add(edge.id)
    if (edge.kind === 'approval') continue
    if (edge.kind !== 'execution') throw new DomainError('WORKFLOW_EDGE_INVALID', 'A relationship requires an explicit kind.', 409)
    incoming.get(edge.target)!.push(edge)
    outgoing.get(edge.source)!.push(edge)
  }
  if (incoming.get(version.entryNodeId)!.length) {
    throw new DomainError('WORKFLOW_ENTRY_DEPENDENCY', 'The entry cannot have an incoming execution dependency.', 409)
  }
  // Deterministic input order is by relationship identity, never layout or array position.
  for (const edges of [...incoming.values(), ...outgoing.values()]) edges.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const degrees = new Map([...incoming].map(([id, edges]) => [id, edges.length]))
  const queue = [...nodes].filter((id) => degrees.get(id) === 0).sort()
  const depth = new Map([...nodes].map((id) => [id, 1]))
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    for (const edge of outgoing.get(id)!) {
      depth.set(edge.target, Math.max(depth.get(edge.target)!, depth.get(id)! + 1))
      const remaining = degrees.get(edge.target)! - 1
      degrees.set(edge.target, remaining)
      if (remaining === 0) queue.push(edge.target)
    }
  }
  if (queue.length !== nodes.size) throw new DomainError('WORKFLOW_REPEAT_UNSUPPORTED', 'One-shot execution relationships must be acyclic.', 409)
  const reachable = new Set<string>()
  const visit = [version.entryNodeId]
  for (let head = 0; head < visit.length; head++) {
    const id = visit[head]!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of outgoing.get(id)!) visit.push(edge.target)
  }
  for (const id of reachable) {
    if (incoming.get(id)!.some((edge) => !reachable.has(edge.source))) {
      throw new DomainError('WORKFLOW_EXCLUDED_DEPENDENCY', 'An excluded component cannot supply a selected-component dependency.', 409)
    }
  }
  const order = queue.filter((id) => reachable.has(id))
  return {
    entryNodeId: version.entryNodeId, order, excluded: [...nodes].filter((id) => !reachable.has(id)).sort(),
    incoming, outgoing,
    sinks: order.filter((id) => outgoing.get(id)!.length === 0),
    recursionLimit: Math.max(...order.map((id) => depth.get(id)!)) + 2,
  }
}

export type OneShotAdmissionDecision =
  | { kind: 'resolved'; resolution: import('@graphql/contracts/wave25').NodeResolution }
  | { kind: 'waiting' | 'skipped' | 'excluded' }
  | { kind: 'run'; selected: import('@graphql/contracts/wave25').WorkflowRelationship[] }

/** A missing fact is unresolved, not an unselected edge. Every incoming edge must settle first. */
export function decideOneShotAdmission(
  topology: OneShotTopology, nodeId: string,
  resolutions: ReadonlyMap<string, import('@graphql/contracts/wave25').NodeResolution>,
): OneShotAdmissionDecision {
  if (!topology.incoming.has(nodeId)) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', `Node '${nodeId}' was not found.`, 409)
  const existing = resolutions.get(nodeId)
  if (existing) return { kind: 'resolved', resolution: existing }
  if (topology.excluded.includes(nodeId)) return { kind: 'excluded' }
  if (nodeId === topology.entryNodeId) return { kind: 'run', selected: [] }
  const selected: import('@graphql/contracts/wave25').WorkflowRelationship[] = []
  let unresolved = false
  for (const edge of topology.incoming.get(nodeId)!) {
    const source = resolutions.get(edge.source)
    if (!source) { unresolved = true; continue }
    const yes = source.selectedRelationshipIds.includes(edge.id)
    const no = source.unselectedRelationshipIds.includes(edge.id)
    if (yes === no || (yes && (source.resolution !== 'succeeded' || !source.execution || !source.acceptedResultDigest))) {
      throw new DomainError('WORKFLOW_RESOLUTION_INVALID', `Relationship '${edge.id}' has no unambiguous accepted resolution.`, 409)
    }
    if (yes) selected.push(edge)
  }
  if (unresolved) return { kind: 'waiting' }
  return selected.length ? { kind: 'run', selected } : { kind: 'skipped' }
}

/** Includes a selected branch end even when its node is not a static sink. */
export function selectedTerminalResolutions(
  resolutions: readonly import('@graphql/contracts/wave25').NodeResolution[],
): import('@graphql/contracts/wave25').NodeResolution[] {
  return resolutions.filter((resolution) => resolution.resolution === 'succeeded'
    && resolution.selectedRelationshipIds.length === 0).sort((a, b) => a.workflowNodeId < b.workflowNodeId ? -1 : a.workflowNodeId > b.workflowNodeId ? 1 : 0)
}
