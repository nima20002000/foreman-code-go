import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '../index.js'
import { ExecutableWorkflowV2Schema, WorkflowRunV2Schema } from './workflow.js'
import { RunGraphSnapshotSchema, type GraphExecutionIdentity } from './protocol.js'

/** Synthetic only: does not create a session, consume credentials, or enable admission. */
export function makeWave25Fixture(suffix = 'fixture') {
  const workspaceId = `ws-${suffix}`
  const workflowId = `wf-${suffix}`
  const versionId = `wv-${suffix}`
  const runId = `run-${suffix}`
  const createdAt = '2026-09-21T00:00:00.000Z'
  const configurations = ['a', 'b'].map((name) => AgentConfigurationVersionSchema.parse({
    id: `cfg-${suffix}-${name}`, workspaceId, agentId: `agent-${suffix}-${name}`, productRole: 'coder', version: 1,
    harness: { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: {}, assignedSkills: [], contentHash: 'sha256:' + '0'.repeat(64), createdAt,
  }))
  const nodes = configurations.map((configuration, index) => ({
    id: `node-${suffix}-${index}`, agentId: configuration.agentId, name: `Synthetic Worker ${index + 1}`,
  }))
  const edge = { id: `edge-${suffix}`, kind: 'execution' as const, source: nodes[0]!.id, target: nodes[1]!.id }
  const definition = {
    id: workflowId, workspaceId, name: 'Synthetic one-shot workflow', version: 1,
    executionSemanticsVersion: 2 as const, entryNodeId: nodes[0]!.id,
    executionCondition: { kind: 'manual' as const }, approval: { handler: 'user' as const },
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 }, nodes, edges: [edge],
  }
  const { version } = ExecutableWorkflowV2Schema.parse({
    version: {
      id: versionId, workspaceId, workflowId, version: 1, executionSemanticsVersion: 2,
      entryNodeId: definition.entryNodeId, definition, approval: { handler: 'user' },
      agentConfigurationVersionIds: Object.fromEntries(configurations.map((configuration) => [configuration.agentId, configuration.id])),
      contentHash: 'sha256:' + '0'.repeat(64), createdAt,
    }, configurations,
  })
  const run = WorkflowRunV2Schema.parse({
    id: runId, workspaceId, workflowId, workflowVersionId: versionId, executionSemanticsVersion: 2,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: { handler: 'user' },
    executionCondition: { kind: 'manual' }, executionState: 'queued', outcome: 'pending', input: {}, createdAt,
  })
  const identities: GraphExecutionIdentity[] = nodes.map((node, index) => ({
    workflowNodeId: node.id, executionId: `exec-${suffix}-${index}`, agentId: node.agentId,
    agentConfigurationVersionId: configurations[index]!.id, attempt: 1,
  }))
  const executions = identities.map((identity) => HarnessExecutionSchema.parse({
    id: identity.executionId, runId, workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId, attempt: identity.attempt,
    input: { executionSemanticsVersion: 2, runInput: {}, predecessors: [] }, state: 'queued', createdAt,
  }))
  const scope = { workspaceId, workflowId, runId, workflowVersionId: versionId, executionSemanticsVersion: 2 as const }
  const snapshot = RunGraphSnapshotSchema.parse({
    protocolVersion: 1, scope, asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
    topology: {
      entryNodeId: nodes[0]!.id,
      nodes: identities.map((identity) => ({ workflowNodeId: identity.workflowNodeId, agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId, productRole: 'coder' })),
      relationships: [{ relationshipId: edge.id, kind: edge.kind, source: edge.source, target: edge.target }],
    },
    state: {
      run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
      nodes: nodes.map((node) => ({
        state: { workflowNodeId: node.id, lifecycle: 'not_activated' },
        activity: { workflowNodeId: node.id, status: 'unknown' },
        attention: { workflowNodeId: node.id, pendingInteractionCount: 0, unsettledReviewCount: 0, cleanupPending: false, telemetry: 'unknown' },
      })), inputBindings: [], interactions: [], reviews: [],
    },
  })
  return { configurations, version, run, identities, executions, scope, snapshot, createdAt }
}
