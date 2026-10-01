import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { OperatorConversationStateSchema } from '@graphql/contracts'
import { OperatorChatCommands } from '../src/modules/conversations/operatorChatCommands.js'
import { DomainError } from '../src/modules/errors.js'
const principal: ManagementPrincipal = { id: 'operator-control-owner', name: 'Owner', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['operator_chat:read', 'operator_chat:respond', 'operator_chat:cancel'], scope: {} }] }
const initial = OperatorConversationStateSchema.parse({ conversation: { id: 'conversation', agentId: 'operator', scope: 'application',
  operatorConfigurationVersionId: 'pinned-configuration' }, messages: [], turnState: 'idle', revision: 2, activeRequestId: null })
function ledger() {
  const records = new Map<string, { target_key: unknown; input_hash: unknown; result: Record<string, unknown> }>()
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (sql.includes('with claimed as')) {
      if (records.has(key)) return { rowCount: 0, rows: [] }
      records.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[6])) }); return { rowCount: 1, rows: [] }
    }
    if (sql.includes('with settled as')) { records.get(key)!.result = JSON.parse(String(values[3])); return { rowCount: 1, rows: [] } }
    if (sql.includes('select target_key,input_hash,result')) return { rowCount: 1, rows: [records.get(key)] }
    throw new Error(`Unrecognized control SQL: ${sql}`)
  })
  return { records, pool: { query } as unknown as Pick<pg.Pool, 'query'> }
}
it('uses one Operator receipt across HTTP/MCP with current readback, changed-choice conflict and no repeated native effect', async () => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  let state = initial
  const current = async () => state, perform = vi.fn(async () => state)
  const input = { kind: 'respond', requestId: 'model-request', nativeRequestId: 'native-question', optionId: 'approve-once' }
  await commands.execute(principal, 'http', 'conversation', 'caller-key', input, perform, current)
  state = { ...state, revision: 20 }
  expect((await new OperatorChatCommands(memory.pool).execute(principal, 'mcp', 'conversation', 'caller-key', input, perform, current)).revision).toBe(20)
  expect(perform).toHaveBeenCalledTimes(1)
  await expect(commands.execute(principal, 'mcp', 'conversation', 'caller-key', { ...input, optionId: 'deny' }, perform, current))
    .rejects.toMatchObject({ code: 'OPERATOR_CHAT_REQUEST_CONFLICT' })
  expect(memory.records.size).toBe(1)
})
it('never records authorization loss after dispatch as definite native rejection or replays uncertain effects', async () => {
  const memory = ledger(), commands = new OperatorChatCommands(memory.pool)
  const perform = vi.fn(async (markDispatchAttempt: () => void) => {
    markDispatchAttempt(); throw new DomainError('ACCESS_DENIED', 'Authority changed after dispatch.', 403)
  })
  for (const source of ['http', 'mcp'] as const) await expect(commands.execute(principal, source, 'conversation', 'caller-key',
    { kind: 'respond' }, perform, async () => initial)).rejects.toMatchObject({ code: 'OPERATOR_CHAT_CONTROL_UNCONFIRMED' })
  expect([...memory.records.values()][0]!.result.status).toBe('uncertain')
  expect(perform).toHaveBeenCalledTimes(1)
})
