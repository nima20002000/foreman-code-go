import { expect, it } from 'vitest'
import { RunActivityPublicSchema, type RunActivityPublic } from '@foreman-code/contracts/wave25'
import { requireCiWorkflowActivity } from './helpers/crossComputerCiActivity.js'

const expected = { runId: 'run', agentExecutionIds: ['agent-execution'], jobExecutionIds: ['ci-execution'] }
function activity(kind: RunActivityPublic['kind'], status: RunActivityPublic['status'], sequence: number) {
  return RunActivityPublicSchema.parse({
    id: `activity-${sequence}`, sequence: String(sequence), occurredAt: '2026-10-09T00:00:00.000Z',
    scope: { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', runId: 'run',
      executionSemanticsVersion: 3 },
    source: 'backend', kind, status, severity: 'info', summary: 'Activity',
    refs: { executionId: 'agent-execution', ...(kind === 'job_work' ? { jobExecutionId: 'ci-execution' } : {}) },
  })
}
const agents = [activity('agent_work', 'running', 1), activity('agent_work', 'completed', 2)]
const ci = [activity('job_work', 'queued', 3), activity('job_work', 'running', 4), activity('job_work', 'completed', 5)]

it('requires persisted Agent and CI lifecycle activities', () => {
  expect(() => requireCiWorkflowActivity([...agents, ...ci], expected)).not.toThrow()
})
it('rejects empty history and generic tool activity without CI status', () => {
  expect(() => requireCiWorkflowActivity([], expected)).toThrow('Agent')
  expect(() => requireCiWorkflowActivity([...agents, activity('tool_action', 'completed', 3)], expected)).toThrow('CI')
})
it('rejects missing CI phases or another workflow’s job', () => {
  expect(() => requireCiWorkflowActivity([...agents, ...ci.slice(1)], expected)).toThrow('queued')
  expect(() => requireCiWorkflowActivity([...agents, ...ci.map(item => ({ ...item,
    refs: { ...item.refs, jobExecutionId: 'foreign-ci' } }))], expected)).toThrow('CI')
})
