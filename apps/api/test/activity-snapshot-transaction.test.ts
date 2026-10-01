import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
describe('activity persistence transaction boundaries', () => {
  it('reads missing state in an isolated transaction and always releases', async () => {
    const statements: string[] = []; let released = false
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 } }, release: () => { released = true } }
    const pool = { connect: async () => client, query: async () => { throw new Error('Snapshot escaped transaction') } } as unknown as pg.Pool
    expect(await new PostgresAgentChatRepository(pool).state('missing')).toBeUndefined()
    expect(statements[0]).toBe('begin isolation level repeatable read read only')
    expect(statements.at(-1)).toBe('commit'); expect(released).toBe(true)
  })
  it('keeps populated row, receipt, message and activity reads on one isolated client', async () => {
    const statements: string[] = []
    const client = { query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim(); statements.push(sql)
      if (sql.startsWith('select * from operator_conversations')) return { rows: [{ id: 'conversation', active_request_id: null, origin_run_id: null }], rowCount: 1 }
      if (sql.startsWith('with candidates')) return { rows: [{ messages: [], has_earlier: false }], rowCount: 1 }
      if (sql.startsWith('select (select started_at')) return { rows: [{ started_at: null, latest_request_id: null }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }, release() {} }
    const pool = { connect: async () => client, query: async () => { throw new Error('Read escaped snapshot transaction') } } as unknown as pg.Pool
    const value = await new PostgresAgentChatRepository(pool).state('conversation')
    expect(value).toMatchObject({ row: { id: 'conversation' }, turns: [], messages: [], activeStartedAt: null, activityPage: { activities: [] } })
    expect(statements[0]).toBe('begin isolation level repeatable read read only'); expect(statements.at(-1)).toBe('commit')
    expect(statements.some((sql) => sql.startsWith('with open as'))).toBe(true)
    expect(statements.some((sql) => sql.includes('from operator_conversation_activity'))).toBe(true)
  })
  it('checks native identity inside the same locked mutation transaction', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = []; let released = false
    const client = { query: async (sql: string, values: unknown[] = []) => { statements.push({ sql, values }); return { rows: [], rowCount: 0 } }, release: () => { released = true } }
    const pool = { connect: async () => client, query: async () => { throw new Error('Mutation escaped transaction') } } as unknown as pg.Pool
    const repo = new PostgresOperatorActivityRepository(pool)
    expect(await repo.append('conversation', 'A', { id: 'tool', requestId: 'A', kind: 'tool', title: 'Tool', status: 'completed' },
      { nativeSessionId: 'session', nativeTurnId: 'turn', source: { eventId: 'event', sequence: '4' } })).toBeUndefined()
    expect(statements[0]?.sql).toBe('begin')
    expect(statements[1]?.sql).toContain('active_request_id=$2'); expect(statements[1]?.sql).toContain('active_native_turn_id=$4')
    expect(statements[1]?.sql).toContain('for update'); expect(statements[1]?.values).toEqual(['conversation', 'A', 'session', 'turn'])
    expect(statements.at(-1)?.sql).toBe('commit'); expect(released).toBe(true)
  })
})
