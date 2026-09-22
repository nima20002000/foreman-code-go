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

import {
  canonicalGraphJson, ExecutableWorkflowV2Schema, WorkflowDefinitionV2Schema,
  type WorkflowDefinitionV2, type WorkflowVersionV2,
} from '@graphql/contracts/wave25'

import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { compileOneShotTopology, validateExecutableTopology } from '../runs/topology.js'
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
      try { validateHarnessWorkflowCompatibility(byAgent.get(agentId)!.harness, selection.handler,
        selection.handler === 'orchestrator' && agentId === selection.designatedOrchestratorAgentId) }
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

/** V2 acceptance is separate: never send typed relationships through the legacy parser. */
export function buildExecutableWorkflowVersionV2(input: {
  id: string
  definition: WorkflowDefinitionV2
  previousDefinition?: Pick<WorkflowDefinition, 'approval'> | undefined
  initialApproval?: WorkflowApprovalConfiguration | undefined
  version: number
  configurations: readonly AgentConfigurationVersion[]
  createdAt: string
}): WorkflowVersionV2 {
  // Canonical hashes describe the persisted JSON record. The shared draft
  // service may supply explicit undefined for absent optional metadata; validate
  // first, then omit only those JSON-absent properties before hashing.
  const graph = JSON.parse(JSON.stringify(WorkflowDefinitionV2Schema.parse(input.definition))) as WorkflowDefinitionV2
  const entryNodeId = graph.nodes.length === 1 ? graph.nodes[0]!.id : graph.entryNodeId
  if (!entryNodeId || !graph.nodes.some((node) => node.id === entryNodeId)) {
    throw new DomainError('WORKFLOW_HAS_NO_ENTRY_POINT', 'Select an existing entry before saving an executable workflow.', 409)
  }
  // A removed entry is not replaced by array order. A single-node board is the only implicit case.
  if (graph.entryNodeId && !graph.nodes.some((node) => node.id === graph.entryNodeId)) {
    throw new DomainError('WORKFLOW_ENTRY_INVALID', 'The selected entry was removed. Select a new entry explicitly.', 409)
  }
  const byAgent = new Map(input.configurations.map((configuration) => [configuration.agentId, configuration]))
  if (byAgent.size !== input.configurations.length) {
    throw new DomainError('AGENT_CONFIGURATION_AMBIGUOUS', 'An Agent requires exactly one immutable configuration.', 409)
  }
  const pins: Record<string, string> = {}
  const configurations = graph.nodes.map((node) => {
    const configuration = byAgent.get(node.agentId)
    if (!configuration || configuration.workspaceId !== graph.workspaceId) {
      throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', `Agent '${node.agentId}' has no configuration in this workspace.`, 409)
    }
    pins[node.agentId] = configuration.id
    return configuration
  })
  const approval = graph.approval ?? input.previousDefinition?.approval ?? input.initialApproval
  if (!approval) throw new DomainError('WORKFLOW_APPROVAL_REQUIRED', 'Select an explicit approval authority before saving.', 409)
  for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, approval,
    approval.handler === 'orchestrator' && configuration.agentId === approval.designatedOrchestratorAgentId)
  const definition = WorkflowDefinitionV2Schema.parse({
    ...graph, entryNodeId, approval, version: input.version,
    nodes: graph.nodes.map((node) => ({ ...node,
      ...(graph.edges.filter((edge) => edge.kind === 'execution' && edge.target === node.id).length > 1
        ? { join: { mode: 'all' } } : {}),
    })),
    executionPolicy: graph.executionPolicy ?? {
      maxParallelism: 4, maxNodeExecutions: graph.nodes.length,
    },
    createdAt: graph.createdAt ?? input.createdAt, updatedAt: input.createdAt,
  })
  const contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({
    definition, configurations: pins, entryNodeId,
  })).digest('hex')}`
  // Includes all four entry role cases, exact configuration pins, native approval compatibility,
  // reviewer topology and choice declarations. Do not infer roles from node labels.
  const accepted = ExecutableWorkflowV2Schema.parse({
    version: {
      id: input.id, workspaceId: graph.workspaceId, workflowId: graph.id,
      version: input.version, executionSemanticsVersion: 2, definition,
      entryNodeId, agentConfigurationVersionIds: pins, approval, contentHash, createdAt: input.createdAt,
    },
    configurations,
  }).version
  compileOneShotTopology(accepted)
  return accepted
}

/**
 * Create an editable v2 definition from a SAVED immutable version, never from node-array order.
 * This does not mutate the old version, admit a Run, or reinterpret a legacy checkpoint.
 * App reviewer relationship authoring remains the approval lane's explicit acceptance step.
 */
export function migrateSavedWorkflowDefinition(version: WorkflowVersion): WorkflowDefinitionV2 {
  validateExecutableTopology(version)
  return WorkflowDefinitionV2Schema.parse({
    ...version.definition,
    executionSemanticsVersion: 2,
    entryNodeId: version.entryNodeId,
    edges: version.definition.edges.map((edge) => {
      const { route, ...relationship } = edge
      void route
      return { ...relationship, kind: 'execution' }
    }),
    ...(version.approval ? { approval: version.approval } : {}),
  })
}
