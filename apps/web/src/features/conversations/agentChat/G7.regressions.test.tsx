// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@graphql/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { providerFixture } from './f7.testSupport'
import { installChatSource, mountChat } from './testSupport'

const clients: ReturnType<typeof mountChat>['client'][] = []
beforeEach(() => installChatSource())
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals()
})
const mount = async (state: AgentChatState) => {
  const mounted = mountChat(state); clients.push(mounted.client); await mounted.ready(); return mounted
}

describe('G7 contextual notices and first-message availability (React + MSW, not native execution)', () => {
  it('T-05 shows the OpenCode running-turn limitation only while a turn is active', async () => {
    const initial = providerFixture('opencode', agentChatFixtures.idleAfterCompletion)
    const mounted = await mount(initial), note = initial.capabilities.unavailable.steer!
    expect(screen.queryByText(note)).not.toBeInTheDocument()
    const active = providerFixture('opencode', agentChatFixtures.active)
    active.revision = initial.revision + 1
    mounted.mock.setState(active); await act(() => mounted.refresh())
    expect(await screen.findByText(note)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Steer' })).toBeDisabled()
    const idle = { ...initial, revision: active.revision + 1 }
    mounted.mock.setState(idle); await act(() => mounted.refresh())
    await waitFor(() => expect(screen.queryByText(note)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Steer' })).not.toBeInTheDocument()
    expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('T-07 does not offer a composer or pretend a conversation existed for a Run with no stored session', async () => {
    const state = providerFixture('codex')
    state.context = { ...state.context, runId: 'g7-run-without-session' }
    state.availability = { canSend: false, reason: 'native_session_missing',
      message: 'This Run has no stored native session for this Agent. Chat with the Agent outside the Run instead.' }
    const key = agentChatContextKey(state.context)
    useConversationDraftStore.getState().setDraft(key, 'Preserve this selection draft')
    const mounted = await mount(state)
    expect(screen.getByText('No stored session for this Run')).toBeInTheDocument()
    expect(screen.getByText(/No chat exists for this Run selection/)).toBeInTheDocument()
    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument()
    expect(screen.queryByText(/This conversation cannot be resumed/)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Conversation composer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start separate chat without this Run' }))
    expect(mounted.newConversation).toHaveBeenCalledOnce()
    expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(useConversationDraftStore.getState().drafts[key]).toBe('Preserve this selection draft')
  })

  it('T-07 preserves first-send behavior when the selected Agent can create a conversation', async () => {
    const mounted = await mount(providerFixture('codex'))
    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'A permitted first message' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toHaveLength(1))
    expect(mounted.mock.calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      expectedConversationId: null, intent: 'next_turn', content: 'A permitted first message',
    })
  })

  it('T-07 guard retains a lost existing conversation and its editable draft without enabling Send', async () => {
    const state = structuredClone(agentChatFixtures.sessionMissing)
    const mounted = await mount(state)
    expect(screen.getByText(/This conversation cannot be resumed/)).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Keep this existing conversation draft' } })
    expect(input).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mounted.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('T-03/T-08 keeps long notices inside the single transcript and actions in a sibling footer', async () => {
    const state = providerFixture('opencode', agentChatFixtures.active)
    state.messages = state.messages.filter((message) => message.role !== 'assistant')
    state.capabilities.unavailable.steer = 'A long provider-specific explanation. '.repeat(100)
    await mount(state)
    const transcript = screen.getByRole('region', { name: 'Agent conversation transcript' })
    expect(screen.getAllByRole('region', { name: 'Agent conversation transcript' })).toHaveLength(1)
    expect(within(transcript).getByText(/No partial assistant text has been received/)).toBeInTheDocument()
    expect(within(transcript).getByText(/A long provider-specific explanation/)).toBeInTheDocument()
    expect(within(transcript).getByText(/Business occurrence 1/)).toBeInTheDocument()
    const actions = screen.getByRole('group', { name: 'Chat actions' })
    expect(transcript).not.toContainElement(actions)
    expect(actions.parentElement).toBe(transcript.closest('.conversation-viewport')!.parentElement)
    for (const name of ['Queue message', 'Steer', 'Interrupt and send', 'Stop chat']) {
      expect(within(actions).getByRole('button', { name })).toBeInTheDocument()
      expect(within(transcript).queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })
})
