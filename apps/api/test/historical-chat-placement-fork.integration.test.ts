import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { historicalChatPlacement, historicalChatSource, forkHistoricalChat,
  waitForHistoricalChatTurn } from './helpers/historicalChatPlacement.js'

const execute = promisify(execFile)

it.each(['failed', 'canceled'] as const)('reports a %s historical chat turn on its first read', async delivery => {
  vi.useFakeTimers()
  const state = structuredClone(agentChatFixtures.failed)
  state.turns[0]!.delivery = delivery
  const read = vi.fn(async () => state)
  const result = waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')
    .catch(error => error as Error)
  try {
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await result).toMatchObject({ message: expect.stringContaining(`${delivery}: NATIVE_TURN_FAILED`) })
    expect(read).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it('bounds a pending fake-provider chat turn to fifteen seconds', async () => {
  vi.useFakeTimers()
  let settled = false
  const result = waitForHistoricalChatTurn(async () => agentChatFixtures.active, 'request-1', 'Worker chat fork completion')
    .catch(error => { settled = true; return error as Error })
  try {
    await vi.advanceTimersByTimeAsync(15_001)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ message: 'Timed out waiting for Worker chat fork completion.' })
  } finally {
    await vi.advanceTimersByTimeAsync(90_001)
    await result
    vi.useRealTimers()
  }
})

it('reports a historical chat read error without polling again', async () => {
  const read = vi.fn(async () => { throw new Error('Chat read denied') })
  await expect(waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')).rejects.toThrow('Chat read denied')
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(['error', 'unavailable'] as const)('reports a %s historical chat session on its first read', async sessionState => {
  vi.useFakeTimers()
  const state = structuredClone(agentChatFixtures.active)
  state.sessionState = sessionState
  state.availability = { canSend: false, reason: 'harness_unavailable', message: 'Native chat was rejected.' }
  const read = vi.fn(async () => state)
  const result = waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')
    .catch(error => error as Error)
  try {
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await result).toMatchObject({ message: expect.stringContaining(`${sessionState}: harness_unavailable`) })
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it('forks historical chat on its accepted Worker and denies a read-only caller', async () => {
  await historicalChatPlacement(async fixture => {
    const source = await historicalChatSource(fixture)
    const { workspaceId, selection, read } = source
    const reader = await fixture.access.issue({ name: 'Historical chat reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const message = { requestId: randomUUID(), content: 'Continue the saved task.', expectedConversationId: null }
    const denied = await fixture.call('agent_chat_send', { workspaceId, selection, message }, reader.token)
    expect(denied.isError).toBe(true)
    expect((await read()).conversation).toBeNull()
    const listed = JSON.parse((await execute(fixture.provider.binary, ['mcp', 'list', '--json'])).stdout)
    expect(listed).toEqual([expect.objectContaining({ name: 'foreman-code',
      transport: expect.objectContaining({ type: 'stdio', command: process.execPath,
        args: expect.any(Array), env_vars: ['FOREMAN_CODE_MCP_TOKEN'] }) })])
    const { completed, id, execution, before, started } = await forkHistoricalChat(fixture, source, message)
    const calls = await fixture.provider.calls()
    const turns = calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `agent-chat:${id}:${message.requestId}`)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.threadId).toBe(completed.conversation!.nativeSession!.nativeSessionId)
    const forks = calls.filter(call => call.forkedSession)
    expect(forks).toHaveLength(1)
    expect(forks[0]?.forkedSession).toMatchObject({ source: execution.nativeSessionId,
      child: completed.conversation!.nativeSession!.nativeSessionId })
    expect(await fixture.details(started.run.id)).toEqual(before)
  })
}, 240_000)
