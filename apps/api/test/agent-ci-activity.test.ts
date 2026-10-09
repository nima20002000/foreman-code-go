import { describe, expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('ci-activity', 'single')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const row: ActivityReadRow = {
  sequence: '1', source: 'backend', kind: 'ci_state_changed', occurred_at: new Date(fixture.createdAt),
  harness_execution_id: 'agent-execution', execution_node_id: node.id, execution_agent_id: node.agentId,
  execution_attempt: 1, work_activation_id: null, result_outcome: null, native: null,
  ci_ticket_id: 'ticket', ci_execution_id: 'ci-execution', ci_attempt_id: 'ci-attempt', ci_operation_id: 'ci-operation',
  safe_payload: { state: 'queued', outcome: null, suite: 'integration', actorName: 'CI Agent' },
}
function project(value = row) {
  return publicRunActivity(value, fixture.version, fixture.run.id, fixture.run.outcome)
}

describe('Agent CI activity projection', () => {
  it.each([
    ['queued', null, 'queued'], ['preparing', null, 'starting'], ['running', null, 'running'],
    ['terminal', 'succeeded', 'completed'], ['terminal', 'build_failed', 'failed'],
    ['terminal', 'cancelled', 'canceled'], ['terminal', 'timed_out', 'failed'],
  ] as const)('projects %s / %s as %s with both Agent and CI identities', (state, outcome, status) => {
    expect(project({ ...row, safe_payload: { ...row.safe_payload, state, outcome } })).toMatchObject({
      kind: 'job_work', status, actor: { agentId: node.agentId, nodeId: node.id },
      refs: { executionId: 'agent-execution', jobExecutionId: 'ci-execution',
        jobAttemptId: 'ci-attempt', jobOperationId: 'ci-operation' },
      summary: `CI integration ${status}`,
    })
  })

  it('does not claim CI status without its persisted ticket and initiating Agent', () => {
    const unavailable = project({ ...row, ci_ticket_id: null, ci_execution_id: null })
    expect(unavailable.status).toBe('unknown')
    expect(unavailable.refs.jobExecutionId).toBeUndefined()
    expect(project({ ...row, execution_agent_id: 'foreign-agent' }).status).toBe('unknown')
  })

  it('does not expose arbitrary source payload or treat unknown suites as a label', () => {
    const value = project({ ...row, safe_payload: { state: 'queued', suite: 'sk-private-suite',
      command: 'private command', secret: 'private secret' } })
    expect(value.summary).toBe('CI queued')
    expect(JSON.stringify(value)).not.toContain('private')
  })
})
