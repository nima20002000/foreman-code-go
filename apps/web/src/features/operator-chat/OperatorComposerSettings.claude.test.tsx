import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type HarnessDefaults, type HarnessConfiguration } from '@graphql/contracts'
import { queryKeys } from '../../shared/api/query'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { OperatorComposerSettings } from './OperatorComposerSettings'

vi.mock('../../shared/api/harnessSettings', () => ({ useNativeHarnessOptions: () => ({
  data: { models: [{ id: savedClaudeConfiguration.model, name: 'Saved Claude', variants: [], reasoningEfforts: [], serviceTiers: [] },
    { id: 'verified-claude-model', name: 'Verified Claude', variants: [], reasoningEfforts: [], serviceTiers: [] }] },
  isSuccess: true, isPending: false, isError: false,
}) }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount(defaults: HarnessDefaults, selected: HarnessConfiguration = savedClaudeConfiguration) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.harnessDefaults, { defaults })
  clients.push(client)
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><OperatorComposerSettings value={operatorChatSettings(selected)} onChange={onChange} disabled={false} /></QueryClientProvider>)
  return onChange
}
it('changes only the Claude model and omits unsupported effort and Fast mode controls', async () => {
  const onChange = mount({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
  const user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: 'Agent settings: Saved Claude' })
  expect(trigger).not.toHaveTextContent('default')
  await user.click(trigger)
  expect(screen.queryByRole('slider', { name: 'Effort' })).not.toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: 'Fast mode' })).not.toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Claude' })).toBeChecked()
  await user.click(screen.getByRole('button', { name: /Saved Claude\s*Choose model/ }))
  await user.click(screen.getByRole('button', { name: /Verified Claude\s*verified-claude-model/ }))
  expect(onChange).toHaveBeenCalledWith({ harness: 'claude', model: 'verified-claude-model', showThinking: false })
})
it('disables choosing Claude when no actual provider preset exists', async () => {
  mount(DEFAULT_HARNESS_DEFAULTS)
  await userEvent.setup().click(screen.getByRole('button', { name: /Agent settings:/ }))
  expect(screen.getByRole('radio', { name: 'Claude' })).toBeDisabled()
  expect(screen.getByText('Configure a Claude profile in Harness settings before switching to Claude.')).toBeVisible()
})

it('switches to Claude only through its actual saved provider preset', async () => {
  const onChange = mount({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }, DEFAULT_HARNESS_DEFAULTS.codex)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  await user.click(screen.getByRole('radio', { name: 'Claude' }))
  expect(onChange).toHaveBeenCalledWith(operatorChatSettings(savedClaudeConfiguration))
})
