import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from '@graphql/contracts'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { parseChatPreferences, protectedKey } from '../../shared/api/protectedChatStorage'
import { useConversationDraftStore } from '../conversations'

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), send: vi.fn(), remove: vi.fn(), restore: vi.fn() }))
vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  createOperatorConversation: api.create, getOperatorConversation: api.get, sendOperatorMessage: api.send }))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: api.list, deleteOperatorConversation: api.remove, restoreOperatorConversation: api.restore }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))
vi.mock('../../shared/api/harnessSettings', () => ({ useNativeHarnessOptions: () => ({ isSuccess: true, data: { models: [
  { id: 'model-a', name: 'Model A', reasoningEfforts: ['low', 'high'], serviceTiers: ['standard', 'priority'], variants: ['high'] },
  { id: 'model-b', name: 'Model B', reasoningEfforts: ['low'], serviceTiers: ['standard'], variants: [] },
] } }) }))
vi.mock('../../shared/api/query', () => ({ useHarnessDefaultsQuery: () => ({ data: { defaults: DEFAULT_HARNESS_DEFAULTS } }) }))
let client: QueryClient
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.setState({ open: true, historyOpen: true, selectedConversationId: 'conversation-one' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.get.mockResolvedValue(operatorState({ turnState: 'idle', activeRequestId: null }))
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState())] })
  api.remove.mockResolvedValue({ conversationId: 'conversation-one' })
  api.restore.mockResolvedValue({ conversationId: 'conversation-one' })
  api.create.mockResolvedValue({ conversation: { ...operatorState().conversation, id: 'new-chat' } })
})
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks() })
function chat() { render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider></QueryClientProvider>) }
describe('Operator chat UX', () => {
  it('handles /new locally even while a turn is running, without sending it to the agent', async () => {
    api.get.mockResolvedValue(operatorState())
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '/new' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.send).not.toHaveBeenCalled()
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBeUndefined()
  })
  it('offers /new on slash and executes it with Enter without sending a message', async () => {
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByRole('listbox', { name: 'Chat commands' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /new/ })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.send).not.toHaveBeenCalled()
  })
  it('retains /new when creation fails', async () => {
    api.create.mockRejectedValue(new Error('Offline'))
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '/new' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Offline')).toBeInTheDocument()
    expect(input).toHaveValue('/new')
  })
  it('loads older chat rows on scroll without replacing the visible history', async () => {
    api.list.mockImplementation(async (_options, limit = 10) => ({ hasMore: limit < 21, conversations: Array.from({ length: Math.min(limit, 21) }, (_, i) => ({ ...summarizeOperatorConversation(operatorState()), conversationId: `chat-${i}`, title: `Topic ${i}` })) }))
    chat()
    await screen.findByRole('button', { name: /^Topic 0(?: |$)/ })
    expect(screen.queryByRole('button', { name: /^Topic 10(?: |$)/ })).not.toBeInTheDocument()
    fireEvent.scroll(screen.getByRole('complementary', { name: 'Operator conversation history' }))
    expect(await screen.findByRole('button', { name: /^Topic 10(?: |$)/ })).toBeInTheDocument()
    expect(api.list).toHaveBeenLastCalledWith(expect.anything(), 20)
    expect(screen.getByRole('button', { name: /^Topic 0(?: |$)/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('Switch conversation')).not.toBeInTheDocument()
    expect(screen.queryByText(/accepted request IDs/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close Operator chat' })).toHaveLength(1)
  })
  it('removes a chat through its menu and restores it with Undo, without stale polls resurrecting it', async () => {
    api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState({ turnState: 'idle', activeRequestId: null }))] })
    chat()
    fireEvent.click(await screen.findByRole('button', { name: 'Chat options: First conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('conversation-one'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^First conversation/ })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('conversation-one'))
    expect(await screen.findByRole('button', { name: /^First conversation/ })).toBeInTheDocument()
  })

  it('exposes all eight resize handles and keeps titles out of the modal header', async () => {
    chat()
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.getAllByRole('button', { name: /^Resize Operator chat/ })).toHaveLength(8)
    expect(screen.getByRole('dialog', { name: 'Operator chat' }).querySelector(':scope > header')).toBeNull()
    expect(screen.queryByText(/^Operator ·/)).not.toBeInTheDocument()
  })

  it('resizes with keyboard controls and bounds the panel to the viewport', async () => {
    chat()
    const panel = screen.getByRole('dialog', { name: 'Operator chat' })
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 700, 500))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize Operator chat' }), { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('732px')
    expect(panel.style.height).toBe('500px')
  })
  it('shows a typing indicator only while the turn is active', async () => {
    api.get.mockResolvedValue(operatorState())
    chat()
    expect(await screen.findByLabelText('Operator is typing')).toBeInTheDocument()
  })
  it('persists unsent agent settings and clears only the acknowledged selection', () => {
    const settings = operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex, true)
    useOperatorChatStore.getState().setSettingsDraft('conversation-one', settings)
    const saved = parseChatPreferences(JSON.parse(localStorage.getItem(protectedKey('ui'))!))
    expect(saved.settingsDrafts?.['conversation-one']).toEqual(settings)
    useOperatorChatStore.getState().clearSettingsDraft('conversation-one', { ...settings, model: 'old-model' })
    expect(useOperatorChatStore.getState().settingsDrafts['conversation-one']).toEqual(settings)
    useOperatorChatStore.getState().clearSettingsDraft('conversation-one', settings)
    expect(useOperatorChatStore.getState().settingsDrafts['conversation-one']).toBeUndefined()
  })

  it('normalizes unsupported effort and fast mode when changing models', () => {
    const onChange = vi.fn()
    render(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange}
      value={{ harness: 'codex', model: 'model-a', reasoningEffort: 'high', serviceTier: 'priority', showThinking: false }} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: /Agent settings:.*Fast/ })).toHaveTextContent('Fast')
    fireEvent.click(screen.getByRole('button', { name: /Agent settings:/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model B model-b/ }))
    expect(onChange).toHaveBeenCalledWith({ harness: 'codex', model: 'model-b', reasoningEffort: 'low', serviceTier: 'standard', showThinking: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Show thinking' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ showThinking: true }))
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
    expect(onChange).toHaveBeenLastCalledWith(operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.opencode))
  })
})
