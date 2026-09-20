import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from '@graphql/contracts'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { getManagedAgentDefaults } from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import { OperatorChat } from './OperatorChat'
import { configuredOperatorSetup, unconfiguredOperatorSetup } from './operatorSetupTestFixture'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { parseChatPreferences } from '../../shared/api/protectedChatStorage'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
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
vi.mock('../../shared/api/query', async (original) => ({ ...await original<typeof import('../../shared/api/query')>(), useHarnessDefaultsQuery: () => ({ data: { defaults: DEFAULT_HARNESS_DEFAULTS } }) }))
let client: QueryClient
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear()
  clearRevisionedFormPersistence()
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
  it('keeps saved settings usable on refresh failure and hides them after access is denied', async () => {
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ code: 'UNAVAILABLE', message: 'Offline' }, { status: 503 })))
    await client.invalidateQueries({ queryKey: queryKeys.agentDefaults })
    expect(await screen.findByText('Could not refresh Operator settings')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ code: 'ACCESS_DENIED', message: 'Denied' }, { status: 403 })))
    await client.invalidateQueries({ queryKey: queryKeys.agentDefaults })
    expect(await screen.findByText('Operator settings access unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Agent settings:/ })).not.toBeInTheDocument()
  })
  it('blocks OpenCode chat until its Operator MCP installation has been checked successfully', async () => {
    let configured = false
    server.use(
      http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
        value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: DEFAULT_HARNESS_DEFAULTS.opencode } } })),
      http.get('/api/operator/setup', () => HttpResponse.json(configured ? configuredOperatorSetup('opencode') : unconfiguredOperatorSetup('opencode'))),
    )
    chat()
    expect(await screen.findByText('Install Operator MCP in OpenCode first')).toBeVisible()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(api.send).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Open Harness Settings' })).toHaveAttribute('href', '/settings/harnesses?harness=opencode&section=connections')
    configured = true
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(screen.queryByText('Install Operator MCP in OpenCode first')).not.toBeInTheDocument()
  })

  it('does not enable Send for configured setup without an accepted configuration ID', async () => {
    let inspected = false
    server.use(
      http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
        value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: DEFAULT_HARNESS_DEFAULTS.opencode } } })),
      http.get('/api/operator/setup', () => { inspected = true; return HttpResponse.json({ ...configuredOperatorSetup('opencode'), configurationVersionId: undefined }) }),
    )
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    await waitFor(() => {
      expect(inspected).toBe(true)
      const setup = client.getQueryCache().findAll({ queryKey: ['operator-chat', 'setup'] })
      expect(setup.length).toBeGreaterThan(0)
      expect(setup.some((query) => query.state.fetchStatus === 'idle' && query.state.status === 'success')).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.send).not.toHaveBeenCalled()
  })

  it('saves chat model and effort to shared Operator defaults and restores them in a future chat', async () => {
    chat()
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A/ }))
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness.model).toBe('model-a'))
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Effort' })).toBeEnabled())
    fireEvent.change(screen.getByRole('slider', { name: 'Effort' }), { target: { value: '1' } })
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness).toMatchObject({ model: 'model-a', reasoningEffort: 'high' }))
    cleanup(); client.clear(); clearRevisionedFormPersistence()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useOperatorChatStore.getState().select('future-chat')
    api.get.mockResolvedValue(operatorState({ conversation: { ...operatorState().conversation, id: 'future-chat' }, turnState: 'idle', activeRequestId: null }))
    chat()
    fireEvent.click(await screen.findByRole('button', { name: 'Agent settings: Model A, high' }))
  })

  it('retains an uncertain settings save and retries the same revision and command before allowing send', async () => {
    const before = await getManagedAgentDefaults()
    const requests: Record<string, unknown>[] = []
    server.use(http.put('/api/management/settings/agents', async ({ request }) => {
      const input = await request.json() as Record<string, unknown>; requests.push(input)
      return requests.length === 1 ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save outcome unknown' } }, { status: 503 })
        : HttpResponse.json({ replayed: true, value: { ...before, revision: before.revision + 1, value: input.value } })
    }))
    chat()
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hello' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry settings save' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual(requests[0])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
  })

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
  it('ignores legacy per-conversation settings so saved Operator defaults remain authoritative', () => {
    const settings = operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex, true)
    expect(parseChatPreferences({ open: true, settingsDrafts: { 'conversation-one': settings } })).toEqual({ open: true })
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
  it('returns keyboard focus to effort after an automatic settings save', () => {
    const onChange = vi.fn()
    const value = { harness: 'codex' as const, model: 'model-a', reasoningEffort: 'high' as const,
      serviceTier: 'standard' as const, showThinking: false }
    const view = render(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange} value={value} /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Agent settings:/ }))
    const slider = screen.getByRole('slider', { name: 'Effort' })
    slider.focus()
    fireEvent.change(slider, { target: { value: '0' } })
    expect(onChange).toHaveBeenCalledWith({ ...value, reasoningEffort: 'low' })
    view.rerender(<QueryClientProvider client={client}><OperatorComposerSettings disabled onChange={onChange} value={{ ...value, reasoningEffort: 'low' }} /></QueryClientProvider>)
    slider.blur()
    view.rerender(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange} value={{ ...value, reasoningEffort: 'low' }} /></QueryClientProvider>)
    expect(slider).toHaveFocus()
  })
})
