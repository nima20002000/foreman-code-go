import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@graphql/contracts'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { AgentChatCommands } from '../src/modules/conversations/agentChatCommands.js'
import { context, fixture } from './helpers/agentChatF1.js'

function commandPool() {
  const receipts = new Map<string, { target_key: unknown; input_hash: unknown; result: unknown }>()
  const query = async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values.slice(0, 3))
    if (sql.includes('with claimed as')) {
      if (receipts.has(key)) return { rowCount: 0, rows: [] }
      receipts.set(key, { target_key: values[3], input_hash: values[4], result: { status: 'pending' } })
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('with settled as')) { receipts.get(key)!.result = JSON.parse(String(values[3])); return { rowCount: 1, rows: [] } }
    if (sql.includes('select target_key,input_hash,result')) return { rows: [receipts.get(key)], rowCount: 1 }
    throw new Error(`Unexpected command SQL: ${sql}`)
  }
  return { pool: { query } as unknown as pg.Pool, receipts }
}

describe('Agent service control replay current readback', () => {
  for (const kind of ['interrupt', 'cancel_queued', 'respond'] as const) {
    it(`${kind} wires persisted current state through the production callsite on restart/MCP replay`, async () => {
      const f = fixture(), memory = commandPool()
      Object.assign(f.service, { commands: new AgentChatCommands(memory.pool) })
      f.internals.pump = () => {}
      const principal = { ...f.principal, grants: [{ scope: {}, actions: ['agent_chat:read', 'agent_chat:cancel', 'agent_chat:respond'] as Array<'agent_chat:read' | 'agent_chat:cancel' | 'agent_chat:respond'> }] }
      const effect = vi.fn(async () => undefined)
      f.repository.interrupt = async () => undefined
      f.service['interruptActive'] = effect
      f.repository.cancelQueued = async () => { await effect(); return 1 }
      f.store.row.active_request_id = 'A'
      f.store.row.active_native_turn_id = 'turn-A'
      f.store.row.pending_interaction = { session: f.manager.session, turn: { nativeTurnId: 'turn-A', nativeRequestId: 'ask' },
        nativeRequestType: 'permission.asked', request: {}, responseOptions: [{ ...CODEX_APPROVAL_OPTIONS_FIXTURE[0]!, optionId: 'yes' }] }
      f.manager.respond = effect
      const execute = (source: 'http' | 'mcp') => kind === 'interrupt'
        ? f.service.interrupt(principal, context.workspaceId, f.store.row.id, { requestId: `control-${kind}` }, source)
        : kind === 'cancel_queued'
          ? f.service.cancelQueued(principal, context.workspaceId, f.store.row.id, 'queued', { requestId: `control-${kind}` }, source)
          : f.service.respond(principal, context.workspaceId, f.store.row.id,
            { requestId: `control-${kind}`, nativeRequestId: 'ask', optionId: 'yes' }, source)
      try {
        const original = await execute('http')
        const receipt = structuredClone([...memory.receipts.values()][0]!.result)
        f.store.row.revision = Number(f.store.row.revision) + 10
        f.store.row.pending_interaction = null
        Object.assign(f.service, { commands: new AgentChatCommands(memory.pool) })
        const replay = await execute('mcp')
        expect(replay.revision).toBe(original.revision + 10)
        expect(replay.pendingInteraction).toBeUndefined()
        expect(effect).toHaveBeenCalledTimes(1)
        expect([...memory.receipts.values()][0]!.result).toEqual(receipt)
      } finally { await f.service.shutdown() }
    })
  }
})
