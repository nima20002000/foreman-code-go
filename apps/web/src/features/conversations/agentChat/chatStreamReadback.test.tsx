import { act, screen, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { ApiError } from '../../../shared/api/client'
import { agentChatFixtureFor } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { deferred } from '../../run-board/testFixtures'
import { AgentChatTestSource, installChatSource, mountChat } from './testSupport'
import { agentChatStateKey } from './useAgentChat'

const clients: QueryClient[] = []
const releases: (() => void)[] = []

beforeEach(installChatSource)
afterEach(() => {
  releases.splice(0).forEach(release => release())
  clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

async function openChat() {
  const initial = structuredClone(agentChatFixtures.active)
  const mounted = mountChat(initial)
  clients.push(mounted.client)
  await mounted.ready()
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  return { initial, mounted, source: AgentChatTestSource.instances[0]! }
}

it('keeps one stream for scalar-equivalent Board contexts and replaces it when the selected Agent changes', async () => {
  const { initial, mounted, source } = await openChat()
  for (let index = 0; index < 4; index++) {
    mounted.switchContext({ ...initial.context })
  }
  expect(AgentChatTestSource.instances).toHaveLength(1)
  expect(source.close).not.toHaveBeenCalled()

  const nextContext = { ...initial.context, agentId: 'another-agent', workflowNodeId: 'another-node' }
  const nextState = agentChatFixtureFor(initial, nextContext, 'another-conversation')
  mounted.mock.setState(nextState)
  mounted.switchContext(nextContext)
  await waitFor(() => expect(source.close).toHaveBeenCalledOnce())
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(2))
  act(() => source.snapshot(initial))
  expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(nextContext))?.conversation?.id)
    .toBe('another-conversation')
})

it('accepts a slow state read during activity traffic and coalesces one trailing read', async () => {
  const { initial, source } = await openChat()
  const first = deferred<void>()
  const trailing = deferred<void>()
  releases.push(() => first.resolve(), () => trailing.resolve())
  const updated: AgentChatState = { ...initial, revision: initial.revision + 1,
    messages: initial.messages.map(message => ({ ...message, content: 'Readback accepted during activity' })) }
  const signals: (AbortSignal | undefined)[] = []
  vi.spyOn(agentChatApi, 'read').mockImplementation(async (_context, options) => {
    signals.push(options?.signal)
    await (signals.length === 1 ? first.promise : trailing.promise)
    return updated
  })
  act(() => source.snapshot(initial))
  await waitFor(() => expect(signals).toHaveLength(1))
  for (let id = 1; id <= 4; id++) {
    act(() => source.event({ id, conversationId: initial.conversation!.id, type: 'activity',
      data: { requestId: initial.activeTurn!.requestId } }))
  }
  expect(signals[0]?.aborted).toBe(false)
  await act(async () => first.resolve())
  expect((await screen.findAllByText('Readback accepted during activity')).length).toBeGreaterThan(0)
  await waitFor(() => expect(signals).toHaveLength(2))
  expect(signals[0]?.aborted).toBe(false)
  expect(AgentChatTestSource.instances).toHaveLength(1)
  await act(async () => trailing.resolve())
})

it('closes the stream and withdraws private state when the event readback is denied', async () => {
  const { initial, mounted, source } = await openChat()
  const read = vi.spyOn(agentChatApi, 'read').mockRejectedValue(
    new ApiError({ code: 'ACCESS_DENIED', message: 'No access to this chat.' }, 403),
  )
  act(() => source.snapshot(initial))
  await screen.findByText('No access to this chat.')
  await waitFor(() => expect(source.close).toHaveBeenCalledOnce())
  const reads = read.mock.calls.length
  act(() => source.event({ id: 1, conversationId: initial.conversation!.id, type: 'activity', data: {} }))
  expect(read).toHaveBeenCalledTimes(reads)
  expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
  mounted.unmount()
})
