import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'

describe('NIM-2691 native work result boundary', () => {
  it('preserves a complete typed work request and rejects prose without inventing a route', () => {
    const fixture = makeCurrentWorkflowFixture('work-native-result')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? {
        ...node, choice: { outcomes: [{ outcome: 'review',
          target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] },
      } : node),
    } })
    const node = version.definition.nodes[0]!
    const result = { outcome: 'succeeded', output: { routing: { kind: 'request', outcome: 'review' },
      data: { latestDeliverable: { artifactId: 'a-1' }, remainingFindings: [] } } }
    const execution = HarnessExecutionSchema.parse({ id: 'execution-work-result', runId: fixture.run.id,
      workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'completed', result,
      createdAt: fixture.createdAt, finishedAt: fixture.createdAt })
    const ref = { nodeId: node.id, occurrence: null }
    expect(normalizeRepeatTerminal(version, fixture.scope, ref, execution)).toEqual(execution)
    const malformed = HarnessExecutionSchema.parse({ ...execution, result: { outcome: 'succeeded', output: 'Please send this to C.' } })
    expect(normalizeRepeatTerminal(version, fixture.scope, ref, malformed).result).toMatchObject({
      outcome: 'failed', error: { code: 'WORK_RESULT_INVALID', retryable: false },
    })
  })
})
