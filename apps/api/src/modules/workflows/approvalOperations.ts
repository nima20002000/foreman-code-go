import { GraphDraftV2Schema, type GraphDraftV2, type GraphDraftOperationV2 } from '@graphql/contracts/wave25'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

/** Approval subset of the shared v2 UI/Operator draft dispatcher. Returning
 * undefined leaves entry, execution, choice and other operations with their owner. */
export function applyApprovalOperation(draft: GraphDraftV2, operation: GraphDraftOperationV2,
  principal: ManagementPrincipal): GraphDraftV2 | undefined {
  const put = operation.type === 'relationship.put' && operation.relationship.kind === 'approval'
  const remove = operation.type === 'edge.disconnect' && draft.graph.edges.some((edge) => edge.id === operation.edgeId && edge.kind === 'approval')
  if (!put && !remove && operation.type !== 'workflow.set_approval') return undefined
  requireAuthorization(principal, 'graph:edit', { workspaceId: draft.workspaceId, workflowId: draft.workflowId })
  let graph = draft.graph
  if (operation.type === 'workflow.set_approval') {
    graph = { ...graph, approval: operation.approval,
      // Selecting User is an explicit authority change, never an automatic fallback.
      edges: operation.approval.handler === 'user' ? graph.edges.filter((edge) => edge.kind !== 'approval') : graph.edges }
  } else if (operation.type === 'edge.disconnect') graph = { ...graph, edges: graph.edges.filter((edge) => edge.id !== operation.edgeId) }
  else if (operation.type === 'relationship.put') {
    const edge = operation.relationship
    if (graph.edges.some((old) => old.id === edge.id && old.kind === 'execution')) {
      throw new DomainError('APPROVAL_RELATIONSHIP_KIND_CONFLICT', 'An approval operation cannot replace an execution relationship.', 409)
    }
    if (edge.source === edge.target || !graph.nodes.some((node) => node.id === edge.source) || !graph.nodes.some((node) => node.id === edge.target)) {
      throw new DomainError('APPROVAL_RELATIONSHIP_INVALID', 'Choose distinct existing reviewer and requester nodes.', 409)
    }
    const edges = [...graph.edges.filter((old) => old.id !== edge.id), edge]
    const incoming = new Set<string>(), successors = new Map<string, string[]>()
    for (const relationship of edges) if (relationship.kind === 'approval') {
      if (incoming.has(relationship.target)) throw new DomainError('APPROVAL_ASSIGNMENT_CONFLICT', 'A requester can have only one App reviewer.', 409)
      incoming.add(relationship.target)
      successors.set(relationship.source, [...(successors.get(relationship.source) ?? []), relationship.target])
    }
    const queue = [edge.target], visited = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const node = queue[index]!
      if (node === edge.source) throw new DomainError('APPROVAL_RECURSIVE_REVIEW_UNSUPPORTED', 'Recursive review assignments are not supported.', 409)
      if (visited.has(node)) continue
      visited.add(node); queue.push(...(successors.get(node) ?? []))
    }
    graph = { ...graph, edges }
  }
  return GraphDraftV2Schema.parse({ ...draft, graph })
}
