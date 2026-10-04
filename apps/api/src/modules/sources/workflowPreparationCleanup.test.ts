import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { readUnboundWorkflowClosure } from '../interactions/workflowClosure.js'
import { assertWorkflowPreparationClosed, type loadWorkflowPreparation } from './workflowPreparationCleanup.js'

vi.mock('../interactions/workflowClosure.js', () => ({ readUnboundWorkflowClosure: vi.fn() }))

function fixture() {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1, input: {}, state: 'completed',
    result: { outcome: 'canceled' }, createdAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:01:00Z',
  })
  const entry = { phase: 'entered', reservation: { execution: repeatExecutionIdentity(execution) } }
  const sql = { query: async () => ({ rows: [entry] }) } as unknown as GraphSqlClient
  const state = {
    execution, execution_state: 'completed', cleanup_pending: false, session_bound: false,
  } as Awaited<ReturnType<typeof loadWorkflowPreparation>>
  vi.mocked(readUnboundWorkflowClosure).mockReset()
  return { sql, state, entry }
}

it('requires the original unbound close for a stopped attempt that entered native preflight', async () => {
  const f = fixture()
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  vi.mocked(readUnboundWorkflowClosure).mockResolvedValue({
    execution: { ...f.state.execution, workingDirectory: '/source', runtimeDirectory: '/runtime' }, durableGeneration: '1',
  })
  await expect(assertWorkflowPreparationClosed(f.sql, f.state)).resolves.toBeUndefined()
})

it.each(['running', 'cleanup', 'bound', 'native-id', 'success', 'changed-attempt'] as const)(
  'refuses to release a workflow preparation with %s', async defect => {
    const f = fixture()
    if (defect === 'running') f.state.execution_state = 'running'
    if (defect === 'cleanup') f.state.cleanup_pending = true
    if (defect === 'bound') f.state.session_bound = true
    if (defect === 'native-id') f.state.execution.nativeSessionId = 'native'
    if (defect === 'success') f.state.execution.result = { outcome: 'succeeded', output: {} }
    if (defect === 'changed-attempt') f.entry.reservation.execution.attempt++
    await expect(assertWorkflowPreparationClosed(f.sql, f.state)).rejects.toBeDefined()
  },
)
