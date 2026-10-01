import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { settleKnownActivity } from '../src/modules/conversations/settleKnownActivity.js'
function fixture() {
  const writes: string[] = []
  const query = async (sql: string) => {
    if (sql.startsWith('select id')) return { rows: [{ id: 'conversation', active_request_id: 'newer-B' }], rowCount: 1 }
    if (sql.includes('select a.request_id')) return { rows: [{ request_id: 'A', activity_id: 'child', sequence: '4', revision: '2', input_hash: 'hash-A',
      record: { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'unknown' },
      source_provenance: { native: { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', generation: 'generation' },
        ownerNative: { harness: 'codex', sessionId: 'root-session', turnId: 'root-A' }, ownerInputHash: 'hash-A' } }], rowCount: 1 }
    if (sql.startsWith('update')) { writes.push(sql); return { rows: [{ revision: '3' }], rowCount: 1 } }
    return { rows: [], rowCount: 0 }
  }
  return { pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, writes }
}
describe('independent known child settlement', () => {
  it('settles existing exact child after parent while leaving newer current owner fields untouched', async () => {
    const f = fixture()
    expect(await settleKnownActivity(f.pool, 'conversation', 'A', { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'completed' },
      { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', generation: 'generation' })).toMatchObject({ itemRevision: '3' })
    expect(f.writes).toHaveLength(2)
    expect(f.writes.join(' ')).not.toMatch(/active_request_id|active_native_turn_id|last_result|turn_state/)
  })
  it('rejects different native turn/generation before any mutation', async () => {
    const f = fixture()
    expect(await settleKnownActivity(f.pool, 'conversation', 'A', { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'completed' },
      { harness: 'codex', sessionId: 'child-session', turnId: 'other', generation: 'generation' })).toBeUndefined()
    expect(f.writes).toEqual([])
  })
})
