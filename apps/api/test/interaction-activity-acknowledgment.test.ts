import type pg from 'pg'
import type { DurableInteraction } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { readActivityAcknowledgment } from '../src/modules/interactions/activityAcknowledgment.js'

describe('persisted activity acknowledgment accessor', () => {
  it('queries only exact immutable acknowledgment/original source identity and returns no callback authority', async () => {
    let statement = ''; let values: unknown[] = []
    const query = { query: async (sql: string, args: unknown[]) => { statement = sql; values = args; return { rows: [{ worker_acknowledgment_id: 'ack', native_turn_id: 'turn' }] } } } as unknown as Pick<pg.PoolClient, 'query'>
    const interaction = { id: 'interaction', runId: 'run', executionId: 'execution', nativeSessionId: 'session', nativeRequestId: 'request', revision: 4 } as DurableInteraction
    expect(await readActivityAcknowledgment(query, interaction)).toEqual({ workerAcknowledgmentId: 'ack', nativeTurnId: 'turn' })
    expect(values).toEqual(['interaction', 'run', 'execution', 'session', 'request', 4])
    expect(statement).toContain('workflow_native_proofs'); expect(statement).toContain("g.approval_native_ack_source=g.approval_native_ack_record->'nativeSource'")
    expect(statement).not.toMatch(/for update|insert|delete/)
  })
})
