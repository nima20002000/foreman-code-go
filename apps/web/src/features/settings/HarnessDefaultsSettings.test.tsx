import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { queryKeys } from '../../shared/api/query'
import { providerAccountsKey } from '../provider-accounts/providerAccountsQueries'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

vi.mock('./OperatorMcpStatus', () => ({ OperatorMcpStatus: ({ harness }: { harness: string }) => <span>Operator MCP for {harness}</span> }))
vi.mock('./CodexPluginManager', () => ({ CodexPluginManager: () => <p>Plugin catalog</p> }))
vi.mock('./ClaudePluginSummary', () => ({ ClaudePluginSummary: () => <p>Claude plugin summary</p> }))
vi.mock('./HarnessMcpManager', () => ({ HarnessMcpManager: () => <p>Native connections</p> }))

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); useOperatorChatStore.getState().reset() })
function mount(props: Parameters<typeof HarnessDefaultsSettings>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client)
  client.setQueryData(providerAccountsKey(), { revision: 1, accounts: [] })
  client.setQueryData(queryKeys.managedHarnessCatalog, Object.entries({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
    .map(([harness, defaults]) => ({ harness, defaults, defaultsRevision: 4,
      capability: harness === 'codex' ? { ready: true } : null,
      discoveryError: harness === 'claude' ? { code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', message: 'Check the Claude profile.' } : null })))
  render(<QueryClientProvider client={client}><HarnessDefaultsSettings {...props} /></QueryClientProvider>)
}

it('shows Codex and Claude as summary cards with status and no editor', () => {
  mount()
  const codex = screen.getByRole('button', { name: 'Edit Codex defaults' }).closest('.settings-choice') as HTMLElement
  const claude = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  expect(within(codex).getByText('Ready')).toBeVisible()
  expect(within(claude).getByText('Check the Claude profile.')).toBeVisible()
  expect(within(codex).getByText('Operator MCP for codex')).toBeVisible()
  expect(screen.getByRole('region', { name: 'Provider accounts' })).toBeVisible()
  expect(screen.queryByText('OpenCode')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

it('drafts a preset change for the Operator and opens human-only Codex panels', async () => {
  const onOpen = vi.fn()
  mount({ onOpen })
  await userEvent.click(screen.getByRole('button', { name: 'Edit Codex defaults' }))
  expect(useOperatorChatStore.getState().request).toMatchObject({ content: 'Change the Codex preset: ', send: false })
  await userEvent.click(screen.getAllByRole('button', { name: 'Plugins' })[0]!)
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'codex', section: 'plugins' })
  await userEvent.click(screen.getByRole('button', { name: 'Connections' }))
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'codex', section: 'connections' })
})

it.each([['plugins', 'Codex plugins', 'Plugin catalog'], ['connections', 'Codex connections', 'Native connections']] as const)(
  'shows the %s panel in a dialog from the URL', (section, title, content) => {
    mount({ selectedHarness: 'codex', section })
    expect(within(screen.getByRole('dialog', { name: title })).getByText(content)).toBeVisible()
  })

it('opens the Claude plugin summary from its card and URL', async () => {
  const onOpen = vi.fn()
  mount({ selectedHarness: 'claude', section: 'plugins', onOpen })
  expect(within(screen.getByRole('dialog', { name: 'Claude plugins' })).getByText('Claude plugin summary')).toBeVisible()
  const card = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  await userEvent.click(within(card).getByRole('button', { name: 'Plugins' }))
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'claude', section: 'plugins' })
})
