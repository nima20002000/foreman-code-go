import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { workflowDeliverableFailure } from './workflowDeliverable.js'

const known = '7d1c9a52-3f0e-4c41-9a43-3c7a8f1f2b10'
const foreign = '2f1c9a52-3f0e-4c41-9a43-3c7a8f1f2b11'

function fixture(tickets = [known, foreign, known, 'invalid-ticket']) {
  const saved = makeCurrentWorkflowFixture('deliverable-references')
  const node = saved.version.definition.nodes[0]!
  node.outputSchema = { type: 'array', items: { type: 'string', 'x-foreman-reference': 'ciTicket' } }
  const execution: HarnessExecution = { id: 'execution', runId: saved.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId]!,
    attempt: 1, input: {}, state: 'completed', createdAt: saved.version.createdAt,
    finishedAt: saved.version.createdAt, result: { outcome: 'succeeded', output: { text: JSON.stringify(tickets) } } }
  const lookup = vi.fn(async (_query: string, values: unknown[]) => {
    const ids = Array.isArray(values[0]) ? values[0] : [values[0]]
    return { rows: ids.includes(known) && values[1] === saved.version.workspaceId && values[2] === execution.id
      ? [{ id: known }] : [] }
  })
  return { version: saved.version, execution, lookup }
}

describe('workflow deliverable reference lookups', () => {
  it('batches unique ticket IDs and reports every unknown reference path', async () => {
    const f = fixture()
    const failure = await workflowDeliverableFailure({ query: f.lookup }, f.version, f.execution)
    expect(failure).toMatchObject({ outcome: 'failed', error: { code: 'OUTPUT_REFERENCE_UNKNOWN', retryable: false } })
    expect(failure?.error?.message).toContain('/1:')
    expect(failure?.error?.message).toContain('/3:')
    expect(f.lookup).toHaveBeenCalledTimes(1)
    expect(f.lookup.mock.calls[0]![1]).toEqual([[known, foreign], f.version.workspaceId, f.execution.id])
  })

  it('reuses the verdict inside a terminal transaction and reads again in the next transaction', async () => {
    const f = fixture([known, foreign])
    const query = async (text: string, values?: unknown[]) => values ? f.lookup(text, values) : { rows: [] }
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    try {
      await connection.transaction(async sql => {
        const first = await workflowDeliverableFailure(sql, f.version, f.execution)
        const second = await workflowDeliverableFailure(sql, f.version, structuredClone(f.execution))
        expect(second).toEqual(first)
        expect(f.lookup).toHaveBeenCalledTimes(1)
      })
      await connection.transaction(sql => workflowDeliverableFailure(sql, f.version, f.execution))
      expect(f.lookup).toHaveBeenCalledTimes(2)
    } finally {
      await connection.close()
    }
  })

  it('does not reuse a verdict for a changed result in the same transaction', async () => {
    const f = fixture([foreign])
    const query = async (text: string, values?: unknown[]) => values ? f.lookup(text, values) : { rows: [] }
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    try {
      await connection.transaction(async sql => {
        expect(await workflowDeliverableFailure(sql, f.version, f.execution)).toBeDefined()
        const corrected = { ...f.execution, result: { outcome: 'succeeded' as const,
          output: { text: JSON.stringify([known]) } } }
        expect(await workflowDeliverableFailure(sql, f.version, corrected)).toBeUndefined()
        expect(f.lookup).toHaveBeenCalledTimes(2)
      })
    } finally {
      await connection.close()
    }
  })
})
