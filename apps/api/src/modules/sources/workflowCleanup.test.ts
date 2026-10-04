import { beforeEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { localWorkflowSourceClosed } from './workflowCleanup.js'

vi.mock('../interactions/workflowClosure.js', () => ({
  readWorkflowClosure: vi.fn(),
  readUnboundWorkflowClosure: vi.fn(),
}))
beforeEach(() => vi.resetAllMocks())

function fixture(bound: boolean, state: 'completed' | 'starting' = 'completed') {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1,
    workingDirectory: '/private/source/tree', runtimeDirectory: '/private/runtime',
    input: {}, state, createdAt: '2026-10-04T00:00:00Z',
    ...(bound ? { nativeSessionId: 'native-session' } : {}),
    ...(state === 'completed' ? {
      result: { outcome: 'canceled' }, finishedAt: '2026-10-04T00:01:00Z',
    } : {}),
  })
  const sql = { query: vi.fn(async () => ({ rows: [{ record: execution }] })) } as unknown as GraphSqlClient
  return { execution, sql }
}

it.each([true, false])('requires stored physical closure when a completed execution is bound=%s', async bound => {
  const f = fixture(bound)
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  const read = bound ? vi.mocked(readWorkflowClosure) : vi.mocked(readUnboundWorkflowClosure)
  expect(read).toHaveBeenCalledWith(f.sql, f.execution)
  if (bound) {
    vi.mocked(readWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
      session: { harness: 'codex', nativeSessionId: 'native-session', providerVersion: '0.154.0' },
    } as NonNullable<Awaited<ReturnType<typeof readWorkflowClosure>>>)
  } else {
    vi.mocked(readUnboundWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
    } as NonNullable<Awaited<ReturnType<typeof readUnboundWorkflowClosure>>>)
  }
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(true)
})

it('keeps a live execution claim even if a previous lifetime has closure evidence', async () => {
  const f = fixture(false, 'starting')
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  expect(readUnboundWorkflowClosure).not.toHaveBeenCalled()
  expect(readWorkflowClosure).not.toHaveBeenCalled()
})

it('keeps the claim when execution identity or closure lookup cannot be confirmed', async () => {
  const f = fixture(true)
  expect(await localWorkflowSourceClosed(f.sql, 'another-execution')).toBe(false)
  vi.mocked(readWorkflowClosure).mockRejectedValue(new Error('closure database unavailable'))
  await expect(localWorkflowSourceClosed(f.sql, f.execution.id)).rejects.toThrow('closure database unavailable')
})
