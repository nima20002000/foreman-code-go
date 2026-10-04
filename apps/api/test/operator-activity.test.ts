import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { currentOperatorHistory, openCodeTurnEvents, operatorActivity } from '../src/modules/conversations/operatorActivity.js'
import { nativeAssistantText } from '../src/modules/conversations/operatorText.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'

const event = (type: string, payload: Record<string, unknown>): NativeHarnessEvent => ({ type, payload, sequence: 1, occurredAt: '2026-09-19T00:00:00.000Z' })

describe('Operator native activity projection', () => {
  it('filters live and replayed OpenCode parts by current parent turn and root session', () => {
    const accepts = openCodeTurnEvents('root', () => 'current')
    for (const info of [
      { id: 'old', role: 'assistant', sessionID: 'root', parentID: 'previous' },
      { id: 'child', role: 'assistant', sessionID: 'child-session', parentID: 'current' },
      { id: 'answer', role: 'assistant', sessionID: 'root', parentID: 'current' },
    ]) accepts(event('message.updated', { info }))
    expect(accepts(event('message.part.updated', { part: { sessionID: 'root', messageID: 'old', id: 'part' } }))).toEqual([])
    expect(accepts(event('message.part.updated', { part: { sessionID: 'child-session', messageID: 'child', id: 'part' } }))).toEqual([])
    expect(accepts(event('message.part.updated', { part: { sessionID: 'root', messageID: 'answer', id: 'part' } }))).toHaveLength(1)
    expect(accepts(event('message.part.delta', { sessionID: 'root', messageID: 'answer', partID: 'part', delta: 'new' }))).toHaveLength(1)
    expect(accepts(event('message.part.delta', { sessionID: 'root', messageID: 'unknown', partID: 'part', delta: 'unproven' }))).toEqual([])
    expect(accepts(event('permission.asked', { id: 'approval' }))).toHaveLength(1)
  })
  it('flushes early text, deltas and tool snapshots through the projection in arrival order after exact metadata', () => {
    const accepts = openCodeTurnEvents('root', () => 'current')
    const prefix = event('message.part.updated', { part: { sessionID: 'root', messageID: 'answer', id: 'text', type: 'text', text: 'prefix ' } })
    const tool = event('message.part.updated', { part: { sessionID: 'root', messageID: 'answer', id: 'tool', type: 'tool', tool: 'read', state: { status: 'running', input: { file: 'note' } } } })
    const suffix = event('message.part.delta', { sessionID: 'root', messageID: 'answer', partID: 'text', field: 'text', delta: 'suffix' })
    const kinds = new Map<string, string>()
    const text = [], activity = [], order = []
    for (const native of [prefix, tool, suffix, event('message.updated', { info: { id: 'answer', sessionID: 'root', parentID: 'current', role: 'assistant' } })]) {
      for (const admitted of accepts(native)) {
        order.push(admitted)
        text.push(...nativeAssistantText(admitted, kinds))
        const change = operatorActivity(admitted, 'opencode', 'request')
        if (change) activity.push(change)
      }
    }
    expect(order).toEqual([prefix, tool, suffix])
    expect(text).toEqual([{ partId: 'text', text: 'prefix ', mode: 'replace' }, { partId: 'text', text: 'suffix', mode: 'append' }])
    expect(activity).toMatchObject([{ id: 'tool', kind: 'file_read', status: 'running' }])
  })
  it('keeps foreign ancestry, summary messages, incomplete identities and a new turn closed', () => {
    let turn = 'current'
    const accepts = openCodeTurnEvents('root', () => turn)
    const part = (sessionID: string, messageID: string) => event('message.part.updated', { part: { sessionID, messageID, id: 'same-part', type: 'text', text: 'foreign' } })
    expect(accepts(part('child', 'same-message'))).toEqual([])
    expect(accepts(part('root', 'same-message'))).toEqual([])
    expect(accepts(event('message.updated', { info: { id: 'same-message', sessionID: 'root', parentID: 'old', role: 'assistant' } }))).toEqual([])
    expect(accepts(part('root', 'same-message'))).toEqual([])
    expect(accepts(part('root', 'summary'))).toEqual([])
    expect(accepts(event('message.updated', { info: { id: 'summary', sessionID: 'root', parentID: turn, role: 'assistant', summary: true } }))).toEqual([])
    expect(accepts(event('message.part.delta', { messageID: 'summary', partID: 'same-part', delta: 'unscoped' }))).toEqual([])
    expect(accepts(part('root', 'waiting'))).toEqual([])
    turn = 'next'
    expect(accepts(event('message.updated', { info: { id: 'waiting', sessionID: 'root', parentID: turn, role: 'assistant' } }))).toEqual([])
  })
  it('bounds pending count and bytes while flushing retained complete identities', () => {
    const accepts = openCodeTurnEvents('root', () => 'current')
    for (let index = 0; index < 300; index++) accepts(event('message.part.updated', {
      part: { sessionID: 'root', messageID: 'answer', id: String(index), type: 'text', text: 'prefix' },
    }))
    const flushed = accepts(event('message.updated', { info: { id: 'answer', sessionID: 'root', parentID: 'current', role: 'assistant' } }))
    expect(flushed).toHaveLength(256)
    expect(flushed[0]?.payload.part).toMatchObject({ id: '44' })
    expect(accepts(event('message.part.updated', { part: { sessionID: 'root', messageID: 'large', id: 'large', type: 'text', text: 'x'.repeat(256 * 1024) } }))).toEqual([])
    expect(accepts(event('message.updated', { info: { id: 'large', sessionID: 'root', parentID: 'current', role: 'assistant' } }))).toEqual([])
  })
  it.each([
    ['tool', { type: 'commandExecution', command: 'printf hello', cwd: '/project', commandActions: [{ type: 'unknown', command: 'printf hello' }], aggregatedOutput: 'hello' }],
    ['file_read', { type: 'commandExecution', command: 'cat note.txt', cwd: '/project', commandActions: [{ type: 'read', command: 'cat note.txt', name: 'note.txt', path: '/project/note.txt' }], aggregatedOutput: 'saved note' }],
    ['file_write', { type: 'fileChange', changes: [{ path: '/project/note.txt', kind: { type: 'add' }, diff: '+saved note' }] }],
    ['mcp', { type: 'mcpToolCall', server: 'graphql', tool: 'workspace_list', arguments: {}, result: { content: [{ type: 'text', text: '[]' }] } }],
    ['web_search', { type: 'webSearch', query: 'IANA examples', action: { type: 'search', query: 'IANA examples' } }],
    ['subagent', { type: 'collabAgentToolCall', tool: 'spawnAgent', model: 'gpt-5.6-luna', reasoningEffort: 'high', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }],
  ] as const)('projects Codex %s from structured native items', (kind, item) => {
    const projected = operatorActivity(event('item.completed', { turnId: 'turn', item: { ...item, id: 'item', status: 'completed' } }), 'codex', 'request')
    expect(projected).toMatchObject({ id: 'item', requestId: 'request', kind, status: 'completed' })
  })

  it.each([
    ['bash', 'tool'], ['read', 'file_read'], ['write', 'file_write'], ['edit', 'file_write'],
    ['websearch', 'web_search'], ['webfetch', 'web_search'], ['graphql_operator_workspace_list', 'mcp'], ['task', 'subagent'],
  ] as const)('projects OpenCode %s independently', (tool, kind) => {
    const projected = operatorActivity(event('message.part.updated', { part: { id: 'part', type: 'tool', tool,
      state: { status: 'completed', input: { description: 'Read-only review' }, output: 'done' } } }), 'opencode', 'request')
    expect(projected).toMatchObject({ kind, status: 'completed', output: 'done', requestId: 'request' })
  })

  it('uses only public thinking summaries and does not confuse failures with successful completion', () => {
    expect(operatorActivity(event('item.completed', { item: { id: 'think', type: 'reasoning', summary: ['Public summary'], content: ['Private content'] } }), 'codex', 'request'))
      .toMatchObject({ kind: 'thinking', output: 'Public summary' })
    expect(JSON.stringify(operatorActivity(event('item.completed', { item: { id: 'think', type: 'reasoning', summary: [], content: ['Private content'] } }), 'codex', 'request'))).not.toContain('Private content')
    expect(operatorActivity(event('item.completed', { item: { id: 'tool', type: 'mcpToolCall', server: 'app', tool: 'read', status: 'failed', error: { message: 'Denied' } } }), 'codex', 'request'))
      .toMatchObject({ status: 'failed' })
  })

  it('bounds large details and redacts old scoped credentials before persistence', () => {
    const token = `opm_${'a'.repeat(43)}`
    const projected = operatorActivity(event('item.completed', { item: { id: 'tool', type: 'commandExecution', command: token, commandActions: [], status: 'completed', aggregatedOutput: 'x'.repeat(25000) } }), 'codex', 'request')!
    expect(projected.output).toHaveLength(24000)
    expect(projected.truncated).toBe(true)
    const redacted = nativePersistenceRedactor([]).value(projected)
    expect(JSON.stringify(redacted)).not.toContain(token)
    expect(redacted.input).toContain('[REDACTED]')
  })

  it('does not attach previous turns or other sessions to the current OpenCode request', () => {
    const events = [
      event('message.updated', { info: { id: 'new-answer', role: 'assistant', parentID: 'new-request' } }),
      event('message.updated', { info: { id: 'old-answer', role: 'assistant', parentID: 'old-request' } }),
      event('message.part.updated', { part: { messageID: 'old-answer', id: 'old-tool' } }),
      event('message.part.updated', { part: { messageID: 'new-answer', id: 'new-tool' } }),
    ]
    const selected = currentOperatorHistory({ nativeTurnId: 'new-request', events, pendingInteractions: [] }, 'opencode')
    expect(selected).toEqual([{ ...events[3], payload: { ...events[3]!.payload, nativeMessageCompleted: false } }])
    expect(currentOperatorHistory({ nativeTurnId: 'right-turn', events: [event('item.snapshot', { turnId: 'wrong-turn' })], pendingInteractions: [] }, 'codex')).toEqual([])
  })
})
