import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

describe('F7 repository terminal transition without assistant identity', () => {
  for (const nativeMessageId of [undefined, 'real-id']) it(`settles once without text; nativeMessageId=${nativeMessageId}`, async () => {
    let active: string | null = 'request'
    const queries: string[] = []
    const client = {
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.startsWith('select * from operator_conversations')) return { rows: [{ id: 'chat', active_request_id: active }] }
        if (sql.includes('set active_request_id=null')) active = null
        return { rows: [], rowCount: 1 }
      },
      release() {},
    }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded', output: { text: '' } }, nativeMessageId)).toBe(true)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded' }, nativeMessageId)).toBe(false)
    expect(queries.filter((sql) => sql.includes('insert into operator_conversation_messages'))).toHaveLength(0)
    expect(queries.filter((sql) => sql.includes('update operator_conversation_turns set result'))).toHaveLength(1)
    expect(active).toBeNull()
  })
  it('does not fabricate a provider ID even when terminal result text exists', async () => {
    const queries: string[] = []
    const client = { query: async (sql: string) => {
      queries.push(sql)
      return { rows: sql.startsWith('select') ? [{ active_request_id: 'request' }] : [], rowCount: 1 }
    }, release() {} }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    expect(await repository.finish('chat', 'request', { outcome: 'succeeded', output: { text: 'Real text but no provider message identity' } })).toBe(true)
    expect(queries.some((sql) => sql.includes('insert into operator_conversation_messages'))).toBe(false)
  })
})
