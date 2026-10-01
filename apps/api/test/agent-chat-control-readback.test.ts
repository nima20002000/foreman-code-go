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
  for (const historical of [false, true]) for (const kind of ['interrupt', 'cancel_queued', 'respond'] as const) {
    it(`${kind} remains usable exactly once with 101 ${historical ? 'historical unknown' : 'running'} activities`, async () => {
      const f = fixture(), memory = commandPool()
      const principal = { ...f.principal, grants: [{ scope: {}, actions: ['agent_chat:read', 'agent_chat:cancel', 'agent_chat:respond'] as Array<'agent_chat:read' | 'agent_chat:cancel' | 'agent_chat:respond'> }] }
      await f.active('A')
      for (let index = 0; index < 101; index++) f.store.activityRows.push({ sequence: String(index + 1), revision: '0',
        record: { id: `unfinished-${index}`, requestId: historical ? 'settled-parent' : 'A', kind: 'subagent', title: `Child ${index}`,
          status: historical ? 'unknown' : 'running' } })
      // Admission commits and returns usable bounded state despite presentation overflow.
      const queued = await f.send('queued')
      expect(queued.turn.delivery).toBe('queued')
      expect(queued.state.activitySnapshot?.hasMoreActiveWork).toBe(true)
      Object.assign(f.service, { commands: new AgentChatCommands(memory.pool) })
      const cancel = vi.spyOn(f.manager, 'cancel'), cancelQueued = vi.spyOn(f.repository, 'cancelQueued'), respond = vi.spyOn(f.manager, 'respond').mockResolvedValue(undefined)
      if (kind === 'respond') f.store.row.pending_interaction = { session: f.manager.session,
        turn: { nativeTurnId: 'turn-A', nativeRequestId: 'ask' }, nativeRequestType: 'permission.asked', request: {},
        responseOptions: [{ ...CODEX_APPROVAL_OPTIONS_FIXTURE[0]!, optionId: 'yes' }] }
      const execute = (source: 'http' | 'mcp', caller = principal) => kind === 'interrupt'
        ? f.service.interrupt(caller, context.workspaceId, f.store.row.id, { requestId: `overflow-${kind}`, expectedNativeTurnId: 'turn-A' }, source)
        : kind === 'cancel_queued'
          ? f.service.cancelQueued(caller, context.workspaceId, f.store.row.id, 'queued', { requestId: `overflow-${kind}` }, source)
          : f.service.respond(caller, context.workspaceId, f.store.row.id,
            { requestId: `overflow-${kind}`, nativeRequestId: 'ask', optionId: 'yes' }, source)
      try {
        await expect(execute('mcp', { ...principal, grants: [] })).rejects.toMatchObject({ status: 403 })
        expect(memory.receipts.size).toBe(0)
        expect(cancel).not.toHaveBeenCalled(); expect(cancelQueued).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled()
        const result = await execute('http')
        expect(result.activitySnapshot?.hasMoreActiveWork).toBe(true)
        expect(result.activitySnapshot?.active.filter((work) => work.ref.kind === 'subagent')).toHaveLength(100)
        expect(result.activities).toHaveLength(100)
        expect(result.availability.message).toContain('more than 100 unfinished tools or subagents')
        const receipt = structuredClone([...memory.receipts.values()][0]!.result)
        f.store.row.revision = Number(f.store.row.revision) + 10
        Object.assign(f.service, { commands: new AgentChatCommands(memory.pool) })
        const replay = await execute('mcp')
        expect(replay.revision).toBeGreaterThan(result.revision)
        expect(replay.activitySnapshot?.hasMoreActiveWork).toBe(true)
        expect([...memory.receipts.values()][0]!.result).toEqual(receipt)
        if (kind === 'interrupt') expect(cancel).toHaveBeenCalledTimes(1)
        if (kind === 'cancel_queued') expect(cancelQueued).toHaveBeenCalledTimes(1)
        if (kind === 'respond') expect(respond).toHaveBeenCalledTimes(1)
        // Parent settlement keeps unresolved children unknown and the overflow explicit.
        if (kind !== 'interrupt') f.manager.finish('A')
        await f.idle()
        const settled = await f.read()
        expect(settled.activeTurn).toBeNull()
        expect(settled.activitySnapshot?.hasMoreActiveWork).toBe(true)
        expect(settled.activitySnapshot?.active).toHaveLength(100)
        expect(settled.activitySnapshot?.active.every((work) => work.evidence === 'unknown')).toBe(true)
        const rosterReads = f.store.statements.filter((entry) => entry.sql.startsWith('select record,sequence::text,revision::text') && entry.sql.includes("record->>'status' in"))
        expect(rosterReads.length).toBeGreaterThan(0)
        expect(rosterReads.every((entry) => entry.values[1] === 101)).toBe(true)
      } finally { await f.service.shutdown() }
    })
  }

})
