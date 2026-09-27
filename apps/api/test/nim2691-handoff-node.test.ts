import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema, WorkRequestSchema } from '@graphql/contracts/wave25'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { workHandoffNodeAction } from '../src/modules/runs/workHandoffNode.js'

describe('NIM-2691 workflow activation routing', () => {
  it('fans a finished entry result to both saved connections once', async () => {
    const fixture = makeCurrentWorkflowFixture('work-node-fork', 'parallel')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
    } })
    const source = version.definition.nodes[0]!
    const execution = HarnessExecutionSchema.parse({ id: 'execution-entry', runId: fixture.run.id,
      workflowNodeId: source.id, agentId: source.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
      attempt: 1, input: {}, state: 'completed', createdAt: fixture.createdAt,
      finishedAt: fixture.createdAt, result: { outcome: 'succeeded', output: {
        routing: { kind: 'finish' }, data: { latestDeliverable: { artifact: 'a' }, remainingFindings: [] },
      } },
    })
    const calls: string[] = []
    const store = {
      admitWorkActivation: async () => ({ execution, reused: true }),
      acceptWorkTerminal: async () => ({ kind: 'accepted' as const, execution, replayed: true }),
      admitWorkRequest: async (_executionId: string, relationshipId: string) => {
        calls.push(relationshipId)
        const edge = version.definition.edges.find((item) => item.id === relationshipId)!
        const request = WorkRequestSchema.parse({ scope: fixture.scope, requestId: `request-${relationshipId}`,
          relationshipId, requesterActivationId: 'activation-entry', requesterExecutionId: execution.id,
          destinationActivationId: `activation-${relationshipId}`, requesterNodeId: edge.source,
          destinationNodeId: edge.target, payloadDigest: `sha256:${'0'.repeat(64)}`,
          acceptedAt: fixture.createdAt, ordinal: 1 })
        return { kind: 'accepted' as const, request, replayed: false, destinationReady: true }
      },
      returnWork: async () => { throw new Error('A finish cannot return work') },
    }
    const action = workHandoffNodeAction({ version, store: store as never,
      driver: { candidate: () => { throw new Error('Replay allocated a native attempt') }, observe: async () => undefined },
      limiter: new ExecutionLimiter(2, 10), signal: new AbortController().signal })
    const next = await action('activation-entry')
    expect(calls.sort()).toEqual(version.definition.edges.filter((edge) => edge.source === source.id).map((edge) => edge.id).sort())
    expect(new Set(next)).toEqual(new Set(calls.map((id) => `activation-${id}`)))
  })
})
