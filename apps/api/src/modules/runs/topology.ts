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
