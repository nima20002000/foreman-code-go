import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type HarnessConfiguration } from '@foreman-code/contracts'
import {
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema, ProviderAccountCommandInputSchema,
  ProviderAccountApiKeyInputSchema, ProviderAccountDefaultInputSchema, ProviderAccountsSnapshotSchema, type ProviderAccount, type ProviderAccountsSnapshot,
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
import { accountTarget, authenticationOperation } from './providerAccounts.fixtures'

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
  snapshot.accounts = snapshot.accounts.map(account => ({ ...account,
    binding: { kind: 'slot', accountId: account.id, provider: account.provider, target: accountTarget,
      profileRef: account.id, bindingRevision: 1, subject: null },
    observation: { bindingRevision: 1, generation: 1, sequence: 1, observedAt: '2026-10-01T12:00:00.000Z',
      status: account.status, identity: account.identity, subject: null,
      readiness: account.status === 'signed-out' ? 'sign-in-required' : 'ready' },
  }))
  const writes: unknown[] = []
  let reads = 0
  function updated() {
    snapshot = { ...snapshot, revision: snapshot.revision + 1 }
    return HttpResponse.json({ value: snapshot, replayed: false })
  }
  server.use(
    http.get('/api/local-human', () => HttpResponse.json({ principal: { id: 'account-test-reader', name: 'Test browser',
      expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] } })),
    http.get('/api/provider-accounts/:id/models', ({ params }) => {
      const account = snapshot.accounts.find(value => value.id === params.id)!
      return HttpResponse.json({ binding: account.binding, generation: 1, observedAt: '2026-10-01T12:00:00.000Z',
        models: [{ id: account.provider === 'claude' ? savedClaudeConfiguration.model : DEFAULT_HARNESS_DEFAULTS.codex.model,
          name: 'Original model' }, { id: 'other-model', name: 'Other model' }] })
    }),
    http.post('/api/provider-accounts/:id/authentication', async ({ params, request }) => {
      const input = await request.json()
      writes.push(input)
      const selected = snapshot.accounts.find(value => value.id === params.id)!
      snapshot.accounts = snapshot.accounts.map(value => value.id === selected.id ? { ...value, status: 'login-pending',
        observation: { ...value.observation!, status: 'login-pending', sequence: 2 } } : value)
      snapshot.revision++
      return HttpResponse.json({ value: authenticationOperation({ binding: selected.binding!, state: 'awaiting-human' }), replayed: false })
    }),
    http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(
      authenticationOperation({ binding: snapshot.accounts.find(value => value.id === workId)!.binding! }))),
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
        : params.action === 'default' ? ProviderAccountDefaultInputSchema.parse(body) : ProviderAccountCommandInputSchema.parse(body)
      writes.push(input)
      const selected = snapshot.accounts.find(account => account.id === params.id)!
      snapshot.accounts = snapshot.accounts.map((account): ProviderAccount => {
        if (params.action === 'default' && account.provider === selected.provider) {
          return { ...account, isDefault: account.id === selected.id }
        }
        if (account.id !== selected.id) return account
        if (params.action === 'login') return { ...account, status: 'login-pending' }
        if (params.action === 'logout') return { ...account, status: 'signed-out', identity: null }
        return { ...account, status: 'signed-in', identity: 'work@example.test',
          observation: { ...account.observation!, status: 'signed-in', identity: 'work@example.test', sequence: 3, readiness: 'ready' } }
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
  await waitFor(() => expect(within(work).getByText('Default for new work')).toBeVisible())
  expect(within(personal).queryByText('Default for new work')).not.toBeInTheDocument()
  await user.click(within(work).getByRole('button', { name: 'Authentication progress' }))
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Hide progress' }))
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


it('removes only from selection and renders the persisted tombstone without choosing another default', async () => {
  const data = fixtures()
  server.use(http.post('/api/provider-accounts/:id/remove', async ({ params, request }) => {
    const input = ProviderAccountCommandInputSchema.parse(await request.json())
    data.writes.push(input)
    const accounts = data.snapshot.accounts.map(account => account.id === params.id
      ? { ...account, removedAt: '2026-10-01T13:00:00.000Z', isDefault: false } : account)
    data.snapshot.accounts = accounts
    return HttpResponse.json({ value: { ...data.snapshot, revision: 2 }, replayed: false })
  }))
  const { user } = mount()
  const original = await screen.findByRole('article', { name: 'Personal account' })
  await user.click(within(original).getByRole('button', { name: 'Remove from selection' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('Saved Runs, chats, local credentials and native history are preserved.')
  await user.click(screen.getByRole('button', { name: 'Remove account' }))
  expect(await within(original).findByText(/Removed from selection/)).toBeVisible()
  expect(data.snapshot.accounts.find(account => account.id === workId)?.isDefault).toBe(false)
})

it('keeps a rename draft after a revision conflict and retries against persisted readback', async () => {
  const data = fixtures()
  let requests = 0
  server.use(http.patch('/api/provider-accounts/:id', async ({ params, request }) => {
    const input = ProviderAccountRenameInputSchema.parse(await request.json())
    data.writes.push(input)
    requests++
    if (requests === 1) {
      data.snapshot.revision = 2
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Account changed. Refresh before saving.' } }, { status: 409 })
    }
    data.snapshot.accounts = data.snapshot.accounts.map(account => account.id === params.id ? { ...account, name: input.name } : account)
    return HttpResponse.json({ value: { ...data.snapshot, revision: 3 }, replayed: false })
  }))
  const { user } = mount()
  await user.click(within(await screen.findByRole('article', { name: 'Work account' })).getByRole('button', { name: 'Configure' }))
  const field = screen.getByRole('textbox', { name: 'Account name' })
  await user.type(field, ' updated')
  await user.click(screen.getByRole('button', { name: 'Save name' }))
  expect(await screen.findByText('Account changed. Refresh before saving.')).toBeVisible()
  expect(field).toHaveValue('Work updated')
  await user.click(screen.getByRole('button', { name: 'Save name' }))
  expect(await screen.findByRole('article', { name: 'Work updated account' })).toBeVisible()
  expect(data.writes.at(-1)).toMatchObject({ expectedRevision: 2 })
})

it('keeps status readable when management access is absent', async () => {
  fixtures()
  server.use(http.get('/api/local-human', () => HttpResponse.json({ principal: { id: 'reader', name: 'Read-only browser',
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['provider_accounts:read'], scope: {} }] } })))
  mount()
  const row = await screen.findByRole('article', { name: 'Work account' })
  expect(within(row).getByText('Signed out')).toBeVisible()
  expect(within(row).getByRole('button', { name: 'Configure' })).toBeDisabled()
  expect(within(row).getByRole('button', { name: 'Make default' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Add Codex account' })).toBeDisabled()
})

it('keeps inside clicks and inside-start drags open, then dismisses an unchanged editor from the backdrop', async () => {
  fixtures()
  const { user } = mount()
  const trigger = await screen.findByRole('button', { name: 'Add Codex account' })
  await waitFor(() => expect(trigger).toBeEnabled())
  await user.click(trigger)
  const dialog = screen.getByRole('dialog')
  const field = screen.getByRole('textbox', { name: 'Account name' })
  await user.click(field)
  expect(dialog).toBeVisible()
  fireEvent.pointerDown(field)
  fireEvent.click(dialog)
  expect(dialog).toBeVisible()
  fireEvent.pointerDown(dialog)
  fireEvent.click(dialog)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})
