import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperatorConversationState } from '@graphql/contracts'
import { getOperatorConversation, sendOperatorMessage } from '../../shared/api/client'
import { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { useConversationDraftStore } from '../conversations'
import { ConversationComposer } from '../conversations/ConversationComposer'
import { OperatorChat } from './OperatorChat'
import { OperatorTranscript } from './OperatorTranscript'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { operatorState } from './pr17-test-fixtures'

vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  getOperatorConversation: vi.fn(), sendOperatorMessage: vi.fn(),
}))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: vi.fn() }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: vi.fn((_id, listeners) => {
  listeners.connection?.('connected'); return () => {}
}) }))
const clients: QueryClient[] = []
function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><button>Before chat</button><OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider><button>After chat</button></QueryClientProvider>)
  return client
}
beforeEach(() => {
  vi.clearAllMocks()
  useOperatorChatStore.setState({ open: false, historyOpen: false, selectedConversationId: 'conversation-one' })
  useConversationDraftStore.getState().clearAllDrafts()
  vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState())] })
  vi.mocked(getOperatorConversation).mockImplementation(async (id) => operatorState({ conversation: { ...operatorState().conversation, id } }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals() })

describe('PR17 Operator interaction regressions', () => {
  it('polls attention while closed without downloading message histories', async () => {
    const client = renderChat()
    await waitFor(() => expect(listOperatorConversationSummaries).toHaveBeenCalled())
    expect(getOperatorConversation).not.toHaveBeenCalled()
    const pending = { ...summarizeOperatorConversation(operatorState()), conversationId: 'decision-chat', needsAttention: true }
    vi.mocked(listOperatorConversationSummaries).mockResolvedValue({ conversations: [pending] })
    await act(() => client.invalidateQueries({ queryKey: ['operator-chat', 'summaries'] }))
    const launcher = await screen.findByRole('button', { name: /1 conversation need your decision/ })
    fireEvent.click(launcher)
    await waitFor(() => expect(getOperatorConversation).toHaveBeenCalledWith('decision-chat', expect.anything()))
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('decision-chat')
  })
  it('focuses the nonmodal chat and restores its retained launcher on Escape', async () => {
    renderChat()
    const launcher = screen.getByRole('button', { name: 'Open Operator chat' })
    fireEvent.click(launcher)
    expect(screen.getByRole('dialog', { name: 'Operator chat' })).toHaveAttribute('aria-modal', 'false')
    expect(screen.getByRole('button', { name: 'Close Operator chat' })).toHaveFocus()
    expect(launcher).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Operator chat' }), { key: 'Escape' })
    await waitFor(() => expect(launcher).toHaveFocus())
    expect(launcher).toHaveAttribute('aria-expanded', 'false')
  })
  it('allows drafting, but not sending, while the Operator is active', async () => {
    useOperatorChatStore.setState({ open: true })
    renderChat()
    const textarea = await screen.findByRole('textbox', { name: 'Message' })
    expect(textarea).not.toBeDisabled()
    fireEvent.change(textarea, { target: { value: 'My next message' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBe('My next message')
    expect(sendOperatorMessage).not.toHaveBeenCalled()
    const user = userEvent.setup()
    textarea.focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After chat' })).toHaveFocus()
  })
  it('closes the narrow history drawer after selecting a chat', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    useOperatorChatStore.setState({ open: true, historyOpen: true })
    renderChat()
    expect(useOperatorChatStore.getState().historyOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    fireEvent.click(await screen.findByRole('button', { name: /First conversation/ }))
    expect(useOperatorChatStore.getState().historyOpen).toBe(false)
    expect(screen.queryByRole('complementary', { name: 'Operator conversation history' })).not.toBeInTheDocument()
  })
  it('keeps a newly edited draft when the previous message is acknowledged', () => {
    render(<ConversationComposer conversationId="draft-test" allowEditingWhileSending isSending onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'New draft' } })
    act(() => useConversationDraftStore.getState().clearDraft('draft-test', 'Previous message'))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('New draft')
  })
  it('preserves a reader position and offers an explicit jump to new output', () => {
    const messages: OperatorConversationState['messages'] = operatorState().messages
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const view = render(<QueryClientProvider client={client}><OperatorTranscript messages={messages} partialText="" /></QueryClientProvider>)
    const region = screen.getByRole('region', { name: 'Operator transcript' })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 200 })
    region.scrollTop = 100
    fireEvent.scroll(region)
    view.rerender(<QueryClientProvider client={client}><OperatorTranscript messages={messages} partialText="New response" /></QueryClientProvider>)
    expect(region.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }))
    expect(region.scrollTop).toBe(1_000)
  })
})
