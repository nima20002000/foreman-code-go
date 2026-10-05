// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@foreman-code/contracts'
import type { OperatorConversationHistoryPage } from '@foreman-code/contracts/operator-chat'
import { getOperatorConversationHistory } from '../../shared/api/operatorChatHistory'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { useOperatorChatStore } from './operatorChatStore'
import { OperatorHistory } from './OperatorHistory'

vi.mock('../../shared/api/operatorChatHistory', () => ({ getOperatorConversationHistory: vi.fn() }))
vi.mock('../conversations', () => ({ ConversationHistory: ({ messages }: { messages: Message[] }) =>
  <div>{messages.map((message) => <p key={message.id} data-testid="history-message">{message.content}</p>)}</div> }))
function page(content: string, sequence: string, nextCursor: string | null): OperatorConversationHistoryPage {
  return { conversationId: 'chat', revision: 7, activeRequestId: 'original-id', nextCursor,
    entries: [{ sequence, message: { id: sequence, conversationId: 'chat', role: 'user', content },
      receipt: { requestId: 'original-id', inputHash: 'a'.repeat(64), outcome: null, retryable: false } }] }
}
let client: QueryClient
beforeEach(() => {
  finishSessionChange(); window.localStorage.clear(); useOperatorChatStore.getState().reset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useOperatorChatStore.getState().select('chat')
})
afterEach(() => {
  cleanup(); client.clear(); vi.resetAllMocks(); finishSessionChange()
  window.localStorage.clear(); useOperatorChatStore.getState().reset()
})
function mount() {
  render(<QueryClientProvider client={client}><OperatorHistory /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
}
describe('Operator history pagination and app-instance isolation', () => {
  it('loads older messages with the original opaque cursor and hides receipt metadata without a resend control', async () => {
    vi.mocked(getOperatorConversationHistory).mockResolvedValueOnce(page('Recent command', '9007199254740994', '9007199254740994'))
      .mockResolvedValueOnce(page('Older command', '9007199254740993', null))
    mount()
    await screen.findByText('Recent command')
    expect(screen.queryByText('original-id')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText('Older command')
    expect(screen.getAllByTestId('history-message').map((node) => node.textContent)).toEqual(['Older command', 'Recent command'])
    expect(vi.mocked(getOperatorConversationHistory).mock.calls[1]?.[1]).toEqual({ before: '9007199254740994' })
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })
  it('removes previous-instance cached pages and never displays them under a different app instance', async () => {
    const previousEpoch = identityEpoch()
    vi.mocked(getOperatorConversationHistory).mockResolvedValue(page('Old owner private command', '1', null))
    mount()
    await screen.findByText('Old owner private command')
    act(() => { beginSessionChange(); finishSessionChange() })
    expect(screen.queryByText('Old owner private command')).toBeNull()
    expect(client.getQueryData(['operator-chat', 'history', previousEpoch, 'chat'])).toBeUndefined()
    vi.mocked(getOperatorConversationHistory).mockRejectedValue(new Error('Conversation not found for this owner'))
    act(() => { useOperatorChatStore.getState().select('chat') })
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Old owner private command')).toBeNull()
  })
})
