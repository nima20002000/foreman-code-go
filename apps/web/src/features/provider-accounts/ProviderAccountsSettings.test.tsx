import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type HarnessConfiguration } from '@foreman-code/contracts'
import {
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema, ProviderAccountCommandInputSchema,
  ProviderAccountApiKeyInputSchema, ProviderAccountsSnapshotSchema, type ProviderAccount, type ProviderAccountsSnapshot,
} from '@foreman-code/contracts/provider-accounts'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { UnsavedChangesContext } from '../../shared/ui/unsavedChanges'
import { OperatorComposerSettings } from '../operator-chat/OperatorComposerSettings'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { ProviderAccountsSettings } from './ProviderAccountsSettings'
import { ProviderAccountSelect } from './ProviderAccountSelect'

vi.mock('../../shared/api/harnessSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/harnessSettings')>(),
  useNativeHarnessOptions: (harness: string) => ({
    data: { models: [
      { id: harness === 'claude' ? savedClaudeConfiguration.model : DEFAULT_HARNESS_DEFAULTS.codex.model,
        name: 'Original model', variants: [], reasoningEfforts: ['medium'], serviceTiers: ['standard'] },
      { id: 'other-model', name: 'Other model', variants: [], reasoningEfforts: [], serviceTiers: ['standard'] },
    ] }, isSuccess: true, isPending: false, isError: false,
  }),
  useRefreshNativeHarness: () => ({ isPending: false, isError: false }),
}))

const personalId = '10000000-0000-4000-8000-000000000001'
const workId = '10000000-0000-4000-8000-000000000002'
const keyId = '10000000-0000-4000-8000-000000000003'
const claudeId = '10000000-0000-4000-8000-000000000004'
const clients: QueryClient[] = []
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

function fixtures() {
  let snapshot: ProviderAccountsSnapshot = ProviderAccountsSnapshotSchema.parse({ revision: 1, accounts: [
    { id: personalId, provider: 'codex', name: 'Personal', authMode: 'subscription', isDefault: true,
      status: 'signed-in', identity: 'personal@example.test', revision: 1 },
    { id: workId, provider: 'codex', name: 'Work', authMode: 'subscription', isDefault: false,
      status: 'signed-out', identity: null, revision: 1 },
    { id: keyId, provider: 'claude', name: 'API billing', authMode: 'api-key', isDefault: true,
      status: 'signed-out', identity: null, revision: 1 },
    { id: claudeId, provider: 'claude', name: 'Claude subscription', authMode: 'subscription', isDefault: false,
      status: 'signed-in', identity: 'claude@example.test', revision: 1 },
  ] })
  const writes: unknown[] = []
  let reads = 0
  function updated() {
    snapshot = { ...snapshot, revision: snapshot.revision + 1 }
    return HttpResponse.json({ value: snapshot, replayed: false })
  }
  server.use(
    http.get('/api/provider-accounts', () => { reads += 1; return HttpResponse.json(snapshot) }),
    http.post('/api/provider-accounts', async ({ request }) => {
      const input = ProviderAccountCreateInputSchema.parse(await request.json())
      writes.push(input)
      snapshot.accounts.push({ provider: input.provider, name: input.name, authMode: input.authMode,
        id: '10000000-0000-4000-8000-000000000005',
        isDefault: false, status: 'signed-out', identity: null, revision: 1 })
      return updated()
    }),
    http.patch('/api/provider-accounts/:id', async ({ params, request }) => {
      const input = ProviderAccountRenameInputSchema.parse(await request.json())
      writes.push(input)
      snapshot.accounts = snapshot.accounts.map(account => account.id === params.id ? { ...account, name: input.name } : account)
      return updated()
    }),
    http.post('/api/provider-accounts/:id/:action', async ({ params, request }) => {
      const body = await request.json()
      const input = params.action === 'api-key' ? ProviderAccountApiKeyInputSchema.parse(body)
        : ProviderAccountCommandInputSchema.parse(body)
      writes.push(input)
      const selected = snapshot.accounts.find(account => account.id === params.id)!
      snapshot.accounts = snapshot.accounts.map((account): ProviderAccount => {
        if (params.action === 'default' && account.provider === selected.provider) {
          return { ...account, isDefault: account.id === selected.id }
        }
        if (account.id !== selected.id) return account
        if (params.action === 'login') return { ...account, status: 'login-pending' }
        if (params.action === 'logout') return { ...account, status: 'signed-out', identity: null }
        return { ...account, status: 'signed-in', identity: 'work@example.test' }
      })
      return updated()
    }),
  )
  return { writes, get snapshot() { return snapshot }, get reads() { return reads } }
}

function mount(children = <ProviderAccountsSettings />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }
  client.setQueryData(queryKeys.managedHarnessCatalog, Object.values(defaults).map(configuration => ({
    harness: configuration.harness, defaults: configuration, defaultsRevision: 1, capability: null, discoveryError: null,
  })))
  clients.push(client)
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return { client, user: userEvent.setup() }
}

it('creates a named account and reads back default, rename, login and refreshed status through the API', async () => {
  const data = fixtures()
  const { user } = mount()
  const personal = await screen.findByRole('article', { name: 'Personal account' })
  expect(within(personal).getByText('personal@example.test')).toBeVisible()
  expect(within(personal).getByText('Signed in')).toBeVisible()
  const work = screen.getByRole('article', { name: 'Work account' })
  await user.click(within(work).getByRole('button', { name: 'Make default' }))
  await waitFor(() => expect(within(work).getByText('Default')).toBeVisible())
  expect(within(personal).queryByText('Default')).not.toBeInTheDocument()
  await user.click(within(work).getByRole('button', { name: 'Sign in' }))
  expect(await within(work).findByText('Sign-in pending')).toBeVisible()
  await user.click(within(work).getByRole('button', { name: 'Refresh status' }))
  expect(await within(work).findByText('work@example.test')).toBeVisible()
  await user.click(within(personal).getByRole('button', { name: 'Configure' }))
  await user.clear(screen.getByRole('textbox', { name: 'Account name' }))
  await user.type(screen.getByRole('textbox', { name: 'Account name' }), 'Home')
  await user.click(screen.getByRole('button', { name: 'Save name' }))
  expect(await screen.findByRole('article', { name: 'Home account' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await user.click(screen.getByRole('button', { name: 'Add Claude account' }))
  await user.type(screen.getByRole('textbox', { name: 'Account name' }), 'Studio')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Authentication' }), 'api-key')
  await user.click(screen.getByRole('button', { name: 'Add account' }))
  expect(await screen.findByRole('article', { name: 'Studio account' })).toHaveTextContent('API key')
  expect(data.writes.at(-1)).toMatchObject({ provider: 'claude', name: 'Studio', authMode: 'api-key', expectedRevision: 5 })
  expect(data.reads).toBeGreaterThan(1)
})

it('writes a masked Claude API key without caching or displaying it in metadata readbacks', async () => {
  const data = fixtures()
  const { client, user } = mount()
  const card = await screen.findByRole('article', { name: 'API billing account' })
  await user.click(within(card).getByRole('button', { name: 'Configure' }))
  const field = screen.getByLabelText('New API key')
  expect(field).toHaveAttribute('type', 'password')
  expect(field).toHaveValue('')
  const secret = 'sk-ant-test-value-for-write-only-entry'
  await user.type(field, secret)
  await user.click(screen.getByRole('button', { name: 'Save API key' }))
  await waitFor(() => expect(field).toHaveValue(''))
  expect(data.writes.at(-1)).toMatchObject({ apiKey: secret })
  expect(JSON.stringify(data.snapshot)).not.toContain(secret)
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state))).not.toContain(secret)
  expect(JSON.stringify(client.getMutationCache().getAll().map(mutation => mutation.state))).not.toContain(secret)
  expect(document.body.textContent).not.toContain(secret)
})

it('keeps a rejected account rename editable and shows the permission error', async () => {
  fixtures()
  server.use(http.patch('/api/provider-accounts/:id', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'Account changes are not permitted.' },
  }, { status: 403 })))
  const { user } = mount()
  await user.click(within(await screen.findByRole('article', { name: 'Work account' })).getByRole('button', { name: 'Configure' }))
  const name = screen.getByRole('textbox', { name: 'Account name' })
  await user.type(name, ' renamed')
  await user.click(screen.getByRole('button', { name: 'Save name' }))
  expect(await screen.findByText('Account changes are not permitted.')).toBeVisible()
  expect(name).toHaveValue('Work renamed')
  expect(name).toBeEnabled()
})

it('retries an uncertain create with its original command and blocks dismissing it', async () => {
  fixtures()
  const requests: unknown[] = []
  server.use(http.post('/api/provider-accounts', async ({ request }) => {
    requests.push(await request.json())
    if (requests.length === 1) return HttpResponse.error()
    return HttpResponse.json({ value: { revision: 2, accounts: [] }, replayed: true })
  }))
  const { user } = mount()
  await user.click(await screen.findByRole('button', { name: 'Add Codex account' }))
  await user.type(screen.getByRole('textbox', { name: 'Account name' }), 'Retry account')
  await user.click(screen.getByRole('button', { name: 'Add account' }))
  const retry = await screen.findByRole('button', { name: 'Retry original save' })
  expect(screen.getByRole('textbox', { name: 'Account name' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toBeVisible()
  await user.click(retry)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(requests[1]).toEqual(requests[0])
})

it('uses the shared outside dismissal and consults the unsaved-change guard', async () => {
  fixtures()
  const request = vi.fn(async () => false)
  const context = { request, surfaces: async () => true, changed: () => undefined, register: () => () => undefined }
  const { user } = mount(<UnsavedChangesContext.Provider value={context}><ProviderAccountsSettings /></UnsavedChangesContext.Provider>)
  await user.click(await screen.findByRole('button', { name: 'Add Codex account' }))
  const dialog = screen.getByRole('dialog')
  await user.type(screen.getByRole('textbox', { name: 'Account name' }), 'Unsaved')
  await user.click(screen.getByRole('heading', { name: 'Add Codex account' }))
  expect(request).not.toHaveBeenCalled()
  fireEvent.pointerDown(dialog)
  fireEvent.click(dialog)
  await waitFor(() => expect(request).toHaveBeenCalledOnce())
  expect(dialog).toBeVisible()
})

it('keeps a saved selection and explains that accounts cannot move to another computer', async () => {
  fixtures()
  mount(<ProviderAccountSelect provider="codex" value={personalId} remote onChange={vi.fn()} />)
  const picker = screen.getByRole('combobox', { name: 'Account' })
  await waitFor(() => expect(picker).toHaveValue(personalId))
  expect(picker).toBeDisabled()
  expect(screen.getByText('This account is local to Main. Choose Main before running.')).toBeVisible()
})

it.each(['codex', 'claude'] as const)('keeps an Agent’s %s account when its model changes and saves it', async harness => {
  fixtures()
  const onSave = vi.fn()
  const configuration = harness === 'codex' ? DEFAULT_HARNESS_DEFAULTS.codex : savedClaudeConfiguration
  const selected = harness === 'codex' ? workId : claudeId
  const agent = defaultAgentForHarness(harness, 'test-agent', 'Coder', configuration)
  const { user } = mount(<AgentSettingsForm agent={agent} onClose={() => undefined} onSave={onSave} />)
  const picker = screen.getByRole('combobox', { name: 'Account' })
  await waitFor(() => expect(picker).toBeEnabled())
  await user.selectOptions(picker, selected)
  await user.click(screen.getByRole('combobox', { name: 'Model' }))
  await user.click(screen.getByRole('option', { name: /Other model/ }))
  expect(picker).toHaveValue(selected)
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0]).toMatchObject({ harnessConfiguration: { accountId: selected, model: 'other-model' } })
})

function OperatorSettings({ configuration }: { configuration: HarnessConfiguration }) {
  const [value, setValue] = useState(operatorChatSettings(configuration))
  return <OperatorComposerSettings value={value} onChange={setValue} disabled={false} />
}
it.each(['codex', 'claude'] as const)('keeps the Operator’s %s account when its model changes', async harness => {
  fixtures()
  const { user } = mount(<OperatorSettings configuration={harness === 'codex'
    ? DEFAULT_HARNESS_DEFAULTS.codex : savedClaudeConfiguration} />)
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  const selected = harness === 'codex' ? workId : claudeId
  const picker = screen.getByRole('combobox', { name: 'Account' })
  await waitFor(() => expect(picker).toBeEnabled())
  await user.selectOptions(picker, selected)
  await user.click(screen.getByRole('button', { name: /Original model\s*Choose model/ }))
  await user.click(screen.getByRole('button', { name: /Other model\s*other-model/ }))
  expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue(selected)
})
