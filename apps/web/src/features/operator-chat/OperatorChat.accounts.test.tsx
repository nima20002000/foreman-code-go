import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings,
  SendOperatorMessageRequestSchema, type HarnessConfiguration, type OperatorConversationState,
  type SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import { AgentDefaultsUpdateInputSchema, ManagedAgentDefaultsSchema } from '@foreman-code/contracts/management'
import { ProviderAccountsSnapshotSchema, type AccountProvider } from '@foreman-code/contracts/provider-accounts'
import { server } from '../../mocks/server'
import { useConversationDraftStore } from '../conversations'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { OperatorChat } from './OperatorChat'
import { useOperatorChatStore } from './operatorChatStore'
import { configuredOperatorSetup } from './operatorSetupTestFixture'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { OperatorChatVisibilityProvider } from './visibility'

vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => undefined }))
vi.mock('../../shared/api/harnessSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/harnessSettings')>(),
  useNativeHarnessOptions: () => ({ isSuccess: true, data: { models: [] } }),
}))

const sourceAccountId = '20000000-0000-4000-8000-000000000001'
const otherAccountId = '20000000-0000-4000-8000-000000000002'
const clients: QueryClient[] = []
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
beforeEach(() => {
  window.localStorage.clear()
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.setState({ open: true, historyOpen: false, selectedConversationId: 'conversation-one' })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, options: LockOptions, work: (lock: Lock) => unknown) => {
      options.signal?.throwIfAborted()
      return work({ name, mode: 'exclusive' } as Lock)
    },
  } })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useOperatorChatStore.getState().reset()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

function setup(provider: AccountProvider, mode: 'explicit' | 'default' | 'default-race') {
  const base = provider === 'codex' ? DEFAULT_HARNESS_DEFAULTS.codex : savedClaudeConfiguration
  const sourceConfiguration: HarnessConfiguration = { ...base, accountId: sourceAccountId }
  const source = operatorState({ revision: 7, turnState: 'idle', activeRequestId: null,
    settings: operatorChatSettings(sourceConfiguration),
    messages: [{ id: 'earlier-message', conversationId: 'conversation-one', role: 'assistant', content: 'Earlier answer' }],
  })
  let defaults = ManagedAgentDefaultsSchema.parse({ revision: 3, versionId: null,
    value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator,
      harness: mode === 'explicit' ? sourceConfiguration : base } },
  })
  let child: OperatorConversationState | undefined
  const messages: SendOperatorMessageRequest[] = []
  const edits: unknown[] = []
  const defaultAccountId = mode === 'default-race' ? sourceAccountId : otherAccountId
  server.use(
    http.get('/api/provider-accounts', () => HttpResponse.json(ProviderAccountsSnapshotSchema.parse({
      revision: 2, accounts: [sourceAccountId, otherAccountId].map((id, index) => ({
        id, provider, name: index === 0 ? 'Original account' : 'Other account', authMode: 'subscription',
        status: 'signed-in', identity: null, isDefault: id === defaultAccountId, revision: 1,
      })),
    }))),
    http.get('/api/management/settings/agents', () => HttpResponse.json(defaults)),
    http.put('/api/management/settings/agents', async ({ request }) => {
      const input = AgentDefaultsUpdateInputSchema.parse(await request.json())
      edits.push(input)
      defaults = { value: input.value, revision: defaults.revision + 1, versionId: 'saved-operator-defaults' }
      return HttpResponse.json({ value: defaults, replayed: false })
    }),
    http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup(provider))),
    http.get('/api/operator/conversations/summaries', () => HttpResponse.json({
      conversations: [source, ...(child ? [child] : [])].map(summarizeOperatorConversation),
    })),
    http.get('/api/operator/conversations/:id', ({ params }) => HttpResponse.json(
      params.id === source.conversation.id ? source : child,
    )),
    http.post('/api/operator/conversations/:id/messages', async ({ params, request }) => {
      const input = SendOperatorMessageRequestSchema.parse(await request.json())
      messages.push(input)
      if (params.id !== source.conversation.id || input.forkExpectedRevision !== source.revision) {
        return HttpResponse.json({ error: { code: 'CONVERSATION_REVISION_CONFLICT',
          message: 'The conversation changed before the handoff.' } }, { status: 409 })
      }
      const id = `operator-fork:${input.requestId}`
      child = operatorState({ conversation: { ...source.conversation, id }, revision: 1,
        turnState: 'idle', activeRequestId: null,
        settings: operatorChatSettings({ ...base, accountId: otherAccountId }),
        handoff: { parentConversationId: source.conversation.id, sourceHarness: provider,
          sourceMessageSequence: '1', omittedMessages: 0 },
        messages: [
          { id: 'sent-message', conversationId: id, requestId: input.requestId, role: 'user', content: input.content },
          { id: 'reply-message', conversationId: id, requestId: input.requestId, role: 'assistant', content: 'Continued using the other account' },
        ],
      })
      return HttpResponse.json({ state: child, replayed: false })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled>
    <OperatorChat />
  </OperatorChatVisibilityProvider></QueryClientProvider>)
  return { messages, edits, source, user: userEvent.setup() }
}

it.each(['codex', 'claude'] as const)('sends the source revision and opens a linked %s chat after selecting another account', async provider => {
  const { user, messages, edits, source } = setup(provider, 'explicit')
  expect(await screen.findByText('Earlier answer')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  const picker = screen.getByRole('combobox', { name: 'Account' })
  await waitFor(() => expect(picker).toBeEnabled())
  await user.selectOptions(picker, otherAccountId)
  await waitFor(() => expect(edits).toHaveLength(1))
  const notice = await screen.findByText(/Your next message starts .* chat with prior conversation context/)
  expect(notice).toBeVisible()
  const composer = within(screen.getByRole('form', { name: 'Conversation composer' }))
  fireEvent.change(composer.getByRole('textbox', { name: 'Message' }), { target: { value: 'Continue here' } })
  await waitFor(() => expect(composer.getByRole('button', { name: 'Send message' })).toBeEnabled())
  await user.click(composer.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText('Continued using the other account')).toBeVisible()
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ forkExpectedRevision: source.revision,
    configurationVersionId: source.conversation.operatorConfigurationVersionId,
    content: 'Continue here', settings: { harness: provider, accountId: otherAccountId } })
  expect(useOperatorChatStore.getState().selectedConversationId).toBe(`operator-fork:${messages[0]!.requestId}`)
  expect(screen.getByText('Continued from')).toBeVisible()
})

it.each(['codex', 'claude'] as const)('resolves the current %s provider default when deciding whether to hand off', async provider => {
  const { user, messages, source } = setup(provider, 'default')
  expect(await screen.findByText(/Your next message starts .* chat with prior conversation context/)).toBeVisible()
  const composer = within(screen.getByRole('form', { name: 'Conversation composer' }))
  fireEvent.change(composer.getByRole('textbox', { name: 'Message' }), { target: { value: 'Use the provider default' } })
  await waitFor(() => expect(composer.getByRole('button', { name: 'Send message' })).toBeEnabled())
  await user.click(composer.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText('Continued using the other account')).toBeVisible()
  expect(messages[0]).toMatchObject({ forkExpectedRevision: source.revision, settings: { harness: provider } })
  expect(messages[0]!.settings).not.toHaveProperty('accountId')
})

it('sends the displayed revision when the provider default changes during admission', async () => {
  const { user, messages, source } = setup('codex', 'default-race')
  expect(await screen.findByText('Earlier answer')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  await waitFor(() => expect(screen.getByRole('option', { name: 'Provider default · Original account' })).toBeInTheDocument())
  expect(screen.queryByText(/Your next message starts .* chat with prior conversation context/)).not.toBeInTheDocument()
  const composer = within(screen.getByRole('form', { name: 'Conversation composer' }))
  fireEvent.change(composer.getByRole('textbox', { name: 'Message' }), { target: { value: 'Continue despite the default change' } })
  await waitFor(() => expect(composer.getByRole('button', { name: 'Send message' })).toBeEnabled())
  await user.click(composer.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText('Continued using the other account')).toBeVisible()
  expect(messages[0]).toMatchObject({ forkExpectedRevision: source.revision })
})
