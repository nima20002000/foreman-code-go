import type { RunActivityPublic } from '@foreman-code/contracts/wave25'

export function requireCiWorkflowActivity(items: readonly RunActivityPublic[], expected: {
  runId: string
  agentExecutionIds: string[]
  jobExecutionIds: string[]
}) {
  if (items.some(item => item.scope.runId !== expected.runId)) throw new Error('Activity belongs to another Run.')
  for (const executionId of expected.agentExecutionIds) {
    const states = items.filter(item => item.kind === 'agent_work' && item.refs.executionId === executionId)
      .map(item => item.status)
    if (!states.includes('running') || !states.includes('completed')) {
      throw new Error(`Agent ${executionId} is missing its running or completed Run activity.`)
    }
  }
  for (const executionId of expected.jobExecutionIds) {
    const states = items.filter(item => item.kind === 'job_work' && item.refs.jobExecutionId === executionId)
      .map(item => item.status)
    if (!states.includes('queued') || !states.includes('running') || !states.includes('completed')) {
      throw new Error(`CI ${executionId} is missing its queued, running or completed Run activity.`)
    }
  }
}
