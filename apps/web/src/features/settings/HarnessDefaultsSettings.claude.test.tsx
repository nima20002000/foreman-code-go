import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_FULL_ACCESS_REQUIRED, DEFAULT_HARNESS_DEFAULTS, type HarnessDefaults, type ClaudeHarnessConfiguration } from '@foreman-code/contracts'
import { HarnessDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { queryKeys } from '../../shared/api/query'
import { getManagedHarnessCatalog } from '../../shared/api/client'
import { server } from '../../mocks/server'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { nativeOptionsFixture } from './settingsExperience.fixtures'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

vi.mock('../../shared/api/harnessSettings', () => ({
  useNativeHarnessOptions: (harness: 'codex' | 'opencode' | 'claude') => nativeOptionsFixture(harness === 'claude' ? 'opencode' : harness),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useAutomaticHarnessCheck: () => ({ current: false, result: { isFetching: false, isSuccess: false, isError: false } }),
  useHarnessSessionEpoch: () => 0,
  useClaudeSetupOptions: () => ({ data: { graphqlMcp: { type: 'http', url: 'http://127.0.0.1:3999/mcp' } }, isError: false }),
  useNativeMcpServers: () => ({ data: undefined }),
}))
vi.mock('./HarnessDirectoryPicker', () => ({ HarnessDirectoryPicker: () => <div>Folder picker</div> }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); for (const client of clients.splice(0)) client.clear() })
function setup(defaults: HarnessDefaults, options: { conflicted?: boolean; claudeError?: { code: string; message: string } } = {}) {
  let persisted = structuredClone(defaults)
  let revision = 4
  let submitted: ReturnType<typeof HarnessDefaultsUpdateInputSchema.parse> | undefined
  server.use(
    http.get('/api/management/harnesses', () => HttpResponse.json((['codex', 'opencode', 'claude'] as const)
      .filter((harness) => persisted[harness]).map((harness) => ({ harness, defaults: persisted[harness], defaultsRevision: revision,
        capability: null, discoveryError: harness === 'claude' ? options.claudeError ?? null : null })))),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      submitted = HarnessDefaultsUpdateInputSchema.parse(await request.json())
      if (options.conflicted) { revision += 1; return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Harness defaults changed since they were read.' } }, { status: 409 }) }
      expect(submitted.expectedRevision).toBe(revision)
      persisted = submitted.defaults
      revision += 1
      return HttpResponse.json({ value: { defaults: persisted, revision }, replayed: false })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><HarnessDefaultsSettings /></QueryClientProvider>)
  return { submitted: () => submitted, refresh: () => client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }),
    createClaude: async (claude: ClaudeHarnessConfiguration) => {
      persisted = { ...persisted, claude }; revision += 1
      await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog })
    } }
}
describe('Claude defaults through the HTTP boundary', () => {
  it('shows detected read-only defaults as incomplete and requires an explicit Full access choice', async () => {
    const configuration = { ...savedClaudeConfiguration, sandbox: 'read-only' as const }
    const state = setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: configuration }, {
      claudeError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED', message: CLAUDE_FULL_ACCESS_REQUIRED },
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit Claude defaults' }))
    expect(screen.getByText('Preset needs configuration')).toBeVisible()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    const sandbox = screen.getByRole('combobox', { name: 'Sandbox' })
    expect(sandbox).toHaveValue('read-only')
    await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
    expect(state.submitted()).toBeUndefined()
    expect(sandbox).toHaveValue('read-only')
    await user.selectOptions(sandbox, 'danger-full-access')
    await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(state.submitted()?.defaults.claude).toEqual({ ...configuration, sandbox: 'danger-full-access' })
  })
  it('saves an explicitly added Claude MCP connection through the revisioned preset boundary', async () => {
    const state = setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: {} } })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit Claude defaults' }))
    await user.click(screen.getByRole('button', { name: 'MCP connections' }))
    await user.click(screen.getByRole('button', { name: 'Add Foreman Code MCP' }))
    await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(state.submitted()?.defaults.claude).toEqual({ ...savedClaudeConfiguration, mcpServers: { 'foreman-code': { type: 'http', url: 'http://127.0.0.1:3999/mcp' } } })
    expect((await getManagedHarnessCatalog()).find(entry => entry.harness === 'claude')?.defaults).toEqual(state.submitted()?.defaults.claude)
  })
  it('requires an explicit new tool choice and pins app-routed approval for it', async () => {
    const state = setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit Claude defaults' }))
    await user.click(screen.getByRole('button', { name: 'Tool permissions' }))
    await user.type(screen.getByRole('textbox', { name: 'Enabled Claude tools' }), 'mcp__graphql__harness_get')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(state.submitted()?.defaults.claude?.permissionRules).toContainEqual({ tool: 'mcp__graphql__harness_get', effect: 'ask' })
    expect(state.submitted()?.defaults.claude?.tools).toEqual([...savedClaudeConfiguration.tools, 'mcp__graphql__harness_get'])
  })
  it.each(['Codex', 'OpenCode'] as const)('keeps exact Claude settings in persisted readback after saving %s', async (name) => {
    setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: `Edit ${name} defaults` }))
    if (name === 'Codex') {
      await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
      await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'workspace-write')
    } else {
      await user.click(screen.getByRole('button', { name: 'Session' }))
      await user.click(screen.getByRole('checkbox', { name: 'Automatic compaction' }))
    }
    await user.click(screen.getByRole('button', { name: `Save ${name} preset` }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    const readback = await getManagedHarnessCatalog()
    expect(readback.find((entry) => entry.harness === 'claude')?.defaults).toEqual(savedClaudeConfiguration)
    expect(readback.map((entry) => entry.defaultsRevision)).toEqual([5, 5, 5])
  })
  it('preserves optional absence when another provider is saved', async () => {
    const state = setup(DEFAULT_HARNESS_DEFAULTS)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit Codex defaults' }))
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'workspace-write')
    await user.click(screen.getByRole('button', { name: 'Save Codex preset' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(state.submitted()?.defaults).not.toHaveProperty('claude')
    expect((await getManagedHarnessCatalog()).map((entry) => entry.harness)).toEqual(['codex', 'opencode'])
  })
  it('preserves the Claude draft and exact permissions after a revision conflict', async () => {
    const state = setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }, { conflicted: true })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit Claude defaults' }))
    expect(screen.getByText('Claude profile is not verified')).toBeVisible()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    const field = screen.getByRole('textbox', { name: 'Local Claude profile directory' })
    await user.clear(field)
    await user.type(field, '/chosen/new-profile')
    await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
    expect(await screen.findByText('Changes were not saved')).toBeVisible()
    await act(async () => { await state.refresh() })
    expect(await screen.findByText('These defaults changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(field).toHaveValue('/chosen/new-profile')
    await waitFor(() => expect(state.submitted()?.defaults.claude).toEqual({ ...savedClaudeConfiguration, configDirectory: '/chosen/new-profile' }))
    expect((await getManagedHarnessCatalog()).find((entry) => entry.harness === 'claude')?.defaults).toEqual(savedClaudeConfiguration)
  })
})

it('reapplies local empty-setup fields onto an externally created Claude preset and saves exact readback', async () => {
  const state = setup(DEFAULT_HARNESS_DEFAULTS)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Edit Claude defaults' }))
  await user.type(screen.getByRole('textbox', { name: 'Model' }), 'local-chosen-model')
  await user.type(screen.getByRole('textbox', { name: 'Local Claude profile directory' }), '/local/chosen-profile')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Authentication' }), 'api-key')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'danger-full-access')
  await act(async () => { await state.createClaude(savedClaudeConfiguration) })
  expect(await screen.findByText('These defaults changed elsewhere. Your edits are preserved.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Reapply my edits to current defaults' }))
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('local-chosen-model')
  expect(screen.getByRole('textbox', { name: 'Local Claude profile directory' })).toHaveValue('/local/chosen-profile')
  expect(screen.getByRole('combobox', { name: 'Authentication' })).toHaveValue('api-key')
  expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveValue('danger-full-access')
  await user.click(screen.getByRole('button', { name: 'Save Claude preset' }))
  expect(await screen.findByText('Changes saved to the server')).toBeVisible()
  const expected = { ...savedClaudeConfiguration, model: 'local-chosen-model', configDirectory: '/local/chosen-profile',
    authMode: 'api-key', sandbox: 'danger-full-access' }
  expect(state.submitted()?.defaults.claude).toEqual(expected)
  expect(state.submitted()?.expectedRevision).toBe(5)
  const readback = await getManagedHarnessCatalog()
  expect(readback.find((entry) => entry.harness === 'claude')?.defaults).toEqual(expected)
  expect(readback.map((entry) => entry.defaultsRevision)).toEqual([6, 6, 6])
})
