import { createHash } from 'node:crypto'

import {
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  validateHarnessWorkflowCompatibility,
  type AgentConfigurationVersion,
  type WorkflowApprovalConfiguration,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { validateExecutableTopology } from '../runs/topology.js'
import { validateWorkflowApproval } from './approval.js'

/** One acceptance boundary for repository saves, managed validation, and managed saves. */
export function buildExecutableWorkflowVersion(input: {
  id: string
  definition: WorkflowDefinition
  previousDefinition?: WorkflowDefinition | undefined
  initialApproval?: WorkflowApprovalConfiguration | undefined
  version: number
  configurations: readonly AgentConfigurationVersion[]
  createdAt: string
}): WorkflowVersion {
  const graph = input.definition
  const entryNode = graph.nodes[0]
  if (!entryNode) throw new DomainError('WORKFLOW_HAS_NO_ENTRY_POINT', 'Add at least one Agent before saving an executable workflow.', 400)
  const byAgent = new Map(input.configurations.map((configuration) => [configuration.agentId, configuration]))
  const referenced = [...new Set(graph.nodes.map((node) => node.agentId))]
  const configurations: Record<string, string> = {}
  for (const agentId of referenced) {
    const configuration = byAgent.get(agentId)
    if (!configuration || configuration.workspaceId !== graph.workspaceId) {
      throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', `Agent '${agentId}' has no configuration in this workspace.`, 409)
    }
    configurations[agentId] = configuration.id
  }
  // Omission is not a clearing operation. Legacy versions remain unconfigured.
  const selection = graph.approval ?? input.previousDefinition?.approval ?? input.initialApproval
  if (selection) {
    for (const agentId of referenced) {
      try { validateHarnessWorkflowCompatibility(byAgent.get(agentId)!.harness, selection.handler) }
      catch { throw new DomainError('WORKFLOW_HARNESS_APPROVAL_CONFLICT', `Agent '${agentId}' uses native automatic review that conflicts with workflow approval.`, 409) }
    }
  }
  const approval = selection ? validateWorkflowApproval(graph, selection, referenced.map((id) => ({
    id, productRole: byAgent.get(id)!.productRole, harnessConfiguration: byAgent.get(id)!.harness,
  }))) : undefined
  const definition = WorkflowDefinitionSchema.parse({
    ...graph,
    ...(approval ? { approval } : {}),
    version: input.version,
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...(graph.edges.filter((edge) => edge.target === node.id).length > 1 && !node.join
        ? { join: { mode: 'all' } } : {}),
    })),
    edges: graph.edges.map((edge) => ({ ...edge, route: edge.route ?? { outcomes: ['succeeded'] } })),
    executionPolicy: graph.executionPolicy ?? {
      maxParallelism: Math.max(1, graph.nodes.length), maxNodeExecutions: graph.nodes.length,
    },
    createdAt: graph.createdAt ?? input.createdAt,
    updatedAt: input.createdAt,
  })
  const contentHash = `sha256:${createHash('sha256').update(JSON.stringify({ definition, configurations, entryNodeId: entryNode.id })).digest('hex')}`
  const version = WorkflowVersionSchema.parse({
    id: input.id, workspaceId: graph.workspaceId, workflowId: graph.id, version: input.version,
    entryNodeId: entryNode.id, definition, agentConfigurationVersionIds: configurations,
    ...(approval ? { approval } : {}), contentHash, createdAt: input.createdAt,
  })
  validateExecutableTopology(version)
  return version
}
