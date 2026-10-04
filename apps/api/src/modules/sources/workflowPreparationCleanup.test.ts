import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { assertWorkflowPreparationClosed, type loadWorkflowPreparation } from './workflowPreparationCleanup.js'

function fixture() {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, input: {}, state: 'completed',
    result: { outcome: 'canceled' }, createdAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:01:00Z',
  })
  const entry = { phase: 'entered', reservation: { execution: repeatExecutionIdentity(execution) } }
  const sql = { query: async () => ({ rows: [entry] }) } as unknown as GraphSqlClient
  const state = {
    execution, execution_state: 'completed', stop_requested: false, cleanup_pending: false, session_bound: false, nativeSession: null,
  } as Awaited<ReturnType<typeof loadWorkflowPreparation>>
  return { sql, state, entry }
}

it('allows a durable Stop to request worker closure before Main can finish its interrupted execution', async () => {
  const f = fixture()
  f.state.execution_state = 'running'
  f.state.execution.state = 'starting'
  delete f.state.execution.result
  delete f.state.execution.finishedAt
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_ACTIVE' })
  f.state.stop_requested = true
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
})

it('accepts the persisted no-submission outcome of a stopped preparation', async () => {
  const f = fixture()
  f.entry.phase = 'not_submitted'
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
})

it.each(['running', 'bound', 'native-id', 'success', 'changed-attempt'] as const)(
  'refuses to release a workflow preparation with %s', async defect => {
    const f = fixture()
    if (defect === 'running') f.state.execution_state = 'running'
    if (defect === 'bound') f.state.session_bound = true
    if (defect === 'native-id') f.state.execution.nativeSessionId = 'native'
    if (defect === 'success') f.state.execution.result = { outcome: 'succeeded', output: {} }
    if (defect === 'changed-attempt') f.entry.reservation.execution.attempt++
    await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toBeDefined()
  },
)

it('permits closure of the same recorded native session after the Run is fenced', async () => {
  const f = fixture()
  f.state.execution.nativeSessionId = 'original-native'
  f.state.session_bound = true
  f.state.nativeSession = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'original-native' }
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
  f.state.nativeSession.nativeSessionId = 'another-native'
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_ACTIVE' })
})
