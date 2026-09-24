import type pg from 'pg'
import { WorkflowVersionSchema, type WorkflowDefinition, type WorkflowVersion } from '@graphql/contracts'
import { GraphDraftSchema, GraphDraftOperationSchema, type GraphDraft, type ManagementPrincipal } from '@graphql/contracts/management'
import {
  CompatibleWorkflowDefinitionSchema, GraphDraftV2Schema, GraphDraftOperationV2Schema,
  WorkflowDefinitionV2Schema, type GraphDraftOperationV2, type GraphDraftV2,
} from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { requireAuthorization } from '../access/policy.js'
import { buildExecutableWorkflowVersion, buildExecutableWorkflowVersionV2, migrateSavedWorkflowDefinition } from '../workflows/executableVersion.js'
import { restoreWorkflowDraft } from './operatorOperations.js'

/** Internal persistence parsing only. Public v1/v2 request and response schemas
 * remain distinct frozen G1 exports; unknown semantics never falls back to v1. */
export const GraphDraftRecordSchema = {
  parse(value: unknown): GraphDraft {
    const graph = value && typeof value === 'object' && 'graph' in value ? value.graph : undefined
    return graph && typeof graph === 'object' && 'executionSemanticsVersion' in graph
      ? GraphDraftV2Schema.parse(value) : GraphDraftSchema.parse(value)
  },
}
export const WorkflowDefinitionRecordSchema = CompatibleWorkflowDefinitionSchema
export function draftSemantics(draft: GraphDraft): 1 | 2 {
  return 'executionSemanticsVersion' in draft.graph && draft.graph.executionSemanticsVersion === 2 ? 2 : 1
}
export function draftEntry(draft: GraphDraft): string | null {
  return draftSemantics(draft) === 2 ? GraphDraftV2Schema.parse(draft).graph.entryNodeId : draft.graph.nodes[0]?.id ?? null
}

export function buildDraftVersion(input: Parameters<typeof buildExecutableWorkflowVersion>[0]): WorkflowVersion {
  return 'executionSemanticsVersion' in input.definition
    ? buildExecutableWorkflowVersionV2({ ...input, definition: WorkflowDefinitionV2Schema.parse(input.definition) })
    : buildExecutableWorkflowVersion(input)
}

/** Explicit editable upgrade, never rewriting an immutable saved version or Run.
 * Keep unsaved geometry/settings/agents; entry comes from the saved version. */
export async function promoteExecutionDefinition(client: pg.PoolClient, principal: ManagementPrincipal,
  graph: WorkflowDefinition, versionId: string | null): Promise<ReturnType<typeof WorkflowDefinitionV2Schema.parse>> {
  requireAuthorization(principal, 'graph:edit', { workspaceId: graph.workspaceId, workflowId: graph.id })
  if ('executionSemanticsVersion' in graph) return WorkflowDefinitionV2Schema.parse(graph)
  let entryNodeId: string | null = null
  if (versionId) {
    const rows = await client.query<{ record: unknown }>(
      'select record from workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',
      [graph.workspaceId, graph.id, versionId])
    const version = WorkflowVersionSchema.parse(rows.rows[0]?.record)
    entryNodeId = migrateSavedWorkflowDefinition(version).entryNodeId
  }
  return WorkflowDefinitionV2Schema.parse({ ...graph, executionSemanticsVersion: 2, entryNodeId,
    edges: graph.edges.map(({ route, ...edge }) => {
      if (route && (route.outcomes.length !== 1 || route.outcomes[0] !== 'succeeded' || route.result || route.maxTraversals)) {
        throw new DomainError('WORKFLOW_MIGRATION_UNSUPPORTED', 'Legacy conditional/repeating routes cannot be silently converted.', 409)
      }
      return { ...edge, kind: 'execution' }
    }) })
}

/** Execution-owned mutations. Approval relationship creation/assignment stays in
 * the approval lane: the common service offers its separate registered handler.
 * Undefined means an existing legacy-safe operation can use the common path. */
export async function applyExecutionOperation(client: pg.PoolClient, principal: ManagementPrincipal,
  input: GraphDraft, raw: GraphDraftOperationV2): Promise<GraphDraft | undefined> {
  if (draftSemantics(input) !== 2) { GraphDraftOperationSchema.parse(raw); return undefined }
  const operation = GraphDraftOperationV2Schema.parse(raw)
  const draft = GraphDraftV2Schema.parse(input)
  const graph = structuredClone(draft.graph)
  const node = (id: string) => {
    const found = graph.nodes.find((item) => item.id === id)
    if (!found) throw new DomainError('NODE_NOT_FOUND', 'The node is not in this draft.', 404)
    return found
  }
  switch (operation.type) {
    case 'workflow.set_entry':
      if (operation.entryNodeId !== null) node(operation.entryNodeId)
      graph.entryNodeId = operation.entryNodeId
      break
    case 'node.set_choice': {
      const target = node(operation.nodeId)
      if (operation.choice === null) delete target.choice
      else target.choice = operation.choice
      break
    }
    case 'node.replace_v2': {
      const previous = node(operation.node.id)
      if (previous.agentId !== operation.node.agentId) throw new DomainError('AGENT_REFERENCE_CHANGE_UNSUPPORTED', 'Replacing metadata cannot change the Agent identity.', 409)
      // Preserve the independently revisioned layout when meaning is replaced.
      graph.nodes[graph.nodes.findIndex((item) => item.id === previous.id)] = {
        ...operation.node, position: previous.position ?? operation.node.position,
      }
      break
    }
    case 'relationship.put': {
      if (operation.relationship.kind === 'approval') return undefined
      const edge = operation.relationship
      node(edge.source); node(edge.target)
      if (edge.source === edge.target) throw new DomainError('SELF_EDGE_UNSUPPORTED', 'A node cannot depend on itself.', 400)
      const index = graph.edges.findIndex((item) => item.id === edge.id)
      if (index >= 0 && graph.edges[index]!.kind !== 'execution') throw new DomainError('RELATIONSHIP_KIND_CONFLICT', 'Do not replace an approval identity with an execution dependency.', 409)
      if (index < 0) graph.edges.push(edge)
      else graph.edges[index] = edge
      break
    }
    case 'node.remove':
      node(operation.nodeId)
      graph.nodes = graph.nodes.filter((item) => item.id !== operation.nodeId)
      graph.edges = graph.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId)
      if (graph.entryNodeId === operation.nodeId) graph.entryNodeId = null
      break
    case 'workflow.restore_version_v2':
      return GraphDraftV2Schema.parse(await restoreWorkflowDraft(client, principal, draft, operation.versionId))
    default: return undefined
  }
  const referenced = new Set(graph.nodes.map((item) => item.agentId))
  return GraphDraftV2Schema.parse({ ...draft, graph,
    stagedAgents: draft.stagedAgents.filter((item) => referenced.has(item.agent.id)),
    ...(draft.sourceAgentPins ? { sourceAgentPins: draft.sourceAgentPins.filter((item) => referenced.has(item.agentId)) } : {}) })
}

/** Public wrappers consume the exact G1 V2 schemas in the shared service. */
export function assertExecutionDraft(value: GraphDraft): GraphDraftV2 { return GraphDraftV2Schema.parse(value) }
