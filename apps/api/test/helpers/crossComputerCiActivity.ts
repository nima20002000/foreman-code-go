import type { RunActivityPublic } from '@foreman-code/contracts/wave25'

export function requireCiWorkflowActivity(items: readonly RunActivityPublic[], expected: {
  runId: string
  agentExecutionIds: string[]
  ciTicketIds: string[]
}) {
  if (items.some(item => item.scope.runId !== expected.runId)) throw new Error('Activity belongs to another Run.')
  for (const executionId of expected.agentExecutionIds) {
    const states = items.filter(item => item.kind === 'agent_work' && item.refs.executionId === executionId)
      .map(item => item.status)
    if (!states.includes('running') || !states.includes('completed')) {
      throw new Error(`Agent ${executionId} is missing its running or completed Run activity.`)
    }
  }
  // A ticket that finishes between two observations goes from starting straight to completed.
  for (const ticketId of expected.ciTicketIds) {
    const states = items.filter(item => item.kind === 'job_work' && item.refs.ciTicketId === ticketId)
      .map(item => item.status)
    if (!states.includes('queued') || !states.includes('completed')) {
      throw new Error(`CI ${ticketId} is missing its queued or completed Run activity.`)
    }
  }
}
