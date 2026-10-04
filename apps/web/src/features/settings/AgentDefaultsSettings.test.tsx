import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { queryKeys } from '../../shared/api/query'
import { AgentDefaultsSettings } from './AgentDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { nativeOptionsFixture } from './settingsExperience.fixtures'
const { updateDefaults } = vi.hoisted(() => ({ updateDefaults: vi.fn() }))
vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return { ...actual, useUpdateAgentDefaultsMutation: () => useMutation({ mutationFn: updateDefaults }) }
})

vi.mock('../../shared/api/harnessSettings', () => ({
  useNativeHarnessOptions: (harness: 'codex' | 'opencode') => nativeOptionsFixture(harness),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useAutomaticHarnessCheck: () => ({ current: true, result: { isFetching: false, isSuccess: true, isError: false } }),
  useHarnessSessionEpoch: () => 0,
}))
vi.mock('./HarnessDirectoryPicker', () => ({ HarnessDirectoryPicker: () => <div>Folder picker</div> }))

const clients: QueryClient[] = []
function client(value = DEFAULT_AGENT_DEFAULTS, revision = 3) {
  const result = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  result.setQueryData(queryKeys.agentDefaults, { value, revision, versionId: `agents-v${revision}` })
  result.setQueryData(queryKeys.managedHarnessCatalog, Object.entries(DEFAULT_HARNESS_DEFAULTS).map(([harness, defaults]) =>
    ({ harness, defaults, defaultsRevision: 1, capability: null, discoveryError: null })))
  clients.push(result); return result
}
beforeEach(() => { updateDefaults.mockReset(); updateDefaults.mockImplementation(async (input) => ({ value: { value: input.value, revision: input.expectedRevision + 1, versionId: 'agents-next' }, replayed: false })) })
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); for (const item of clients.splice(0)) item.clear() })
describe('Agent defaults page', () => {
  it('uses full access only for a new Operator provider selection', async () => {
    const value = structuredClone(DEFAULT_AGENT_DEFAULTS)
    value.operator.harness = DEFAULT_HARNESS_DEFAULTS.opencode
    const user = userEvent.setup()
    render(<QueryClientProvider client={client(value)}><AgentDefaultsSettings /></QueryClientProvider>)
    await user.click(await screen.findByRole('button', { name: 'Edit Operator defaults' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Harness' }), 'codex')
    await user.click(screen.getByRole('button', { name: 'Save Operator' }))
    await waitFor(() => expect(updateDefaults).toHaveBeenCalledOnce())
    expect(updateDefaults.mock.calls[0]![0].value.operator.harness).toMatchObject({ sandbox: 'danger-full-access' })
    expect(updateDefaults.mock.calls[0]![0].value.coder).toEqual(value.coder)
    expect(updateDefaults.mock.calls[0]![0].value.orchestrator).toEqual(value.orchestrator)
  })

  it('preserves explicitly saved Operator read-only access on unrelated edits', async () => {
    const value = structuredClone(DEFAULT_AGENT_DEFAULTS)
    value.operator.harness = DEFAULT_HARNESS_DEFAULTS.codex
    const user = userEvent.setup()
    render(<QueryClientProvider client={client(value)}><AgentDefaultsSettings /></QueryClientProvider>)
    await user.click(await screen.findByRole('button', { name: 'Edit Operator defaults' }))
    await user.click(screen.getByRole('checkbox', { name: 'Show Operator chat' }))
    await user.click(screen.getByRole('button', { name: 'Save Operator' }))
    await waitFor(() => expect(updateDefaults).toHaveBeenCalledOnce())
    expect(updateDefaults.mock.calls[0]![0].value.operator.harness).toMatchObject({ sandbox: 'read-only' })
  })

  it('starts with three summary cards, then saves only an explicit Operator draft', async () => {
    const queryClient = client(); const user = userEvent.setup()
    render(<QueryClientProvider client={queryClient}><AgentDefaultsSettings /></QueryClientProvider>)
    for (const name of ['Operator','Orchestrator','Coder']) expect(await screen.findByRole('button', { name: `Edit ${name} defaults` })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: 'Show Operator chat' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit Operator defaults' }))
    await user.click(screen.getByRole('checkbox', { name: 'Show Operator chat' }))
    await user.click(screen.getByRole('button', { name: 'Save Operator' }))
    await waitFor(() => expect(updateDefaults).toHaveBeenCalledOnce())
    expect(updateDefaults.mock.calls[0]![0].expectedRevision).toBe(3)
    expect(updateDefaults.mock.calls[0]![0].value.operator.uiEnabled).toBe(false)
    expect(updateDefaults.mock.calls[0]![0].value.coder).toEqual(DEFAULT_AGENT_DEFAULTS.coder)
  })
  it('shows the selected Coder permission rules in their original order', async () => {
    const value = structuredClone(DEFAULT_AGENT_DEFAULTS)
    value.coder.harness = { ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!, permissionRules: [
      { permission: 'shell', pattern: 'git *', effect: 'ask' }, { permission: 'shell', pattern: '*', effect: 'deny' },
    ] } }
    const user=userEvent.setup(); render(<QueryClientProvider client={client(value)}><AgentDefaultsSettings /></QueryClientProvider>)
    await user.click(await screen.findByRole('button',{name:'Edit Coder defaults'})); await user.click(screen.getByRole('button',{name:'Access & approvals'}))
    const patterns=screen.getAllByRole('textbox',{name:/^Pattern \d+$/})
    expect(patterns[0]).toHaveValue('git *');expect(patterns[1]).toHaveValue('*');expect(screen.getByText('Last matching rule wins.')).toBeVisible()
  })
  it('keeps an unsent role draft through overview navigation and unmount', async () => {
    const queryClient=client();const user=userEvent.setup();const first=render(<QueryClientProvider client={queryClient}><AgentDefaultsSettings /></QueryClientProvider>)
    await user.click(await screen.findByRole('button',{name:'Edit Operator defaults'}));await user.click(screen.getByRole('checkbox',{name:'Show Operator chat'}))
    await user.click(screen.getByRole('button',{name:'All agents'}));expect(screen.getByText('Unsaved changes')).toBeVisible()
    await user.click(screen.getByRole('button',{name:'Edit Coder defaults'}));expect(screen.getByRole('button',{name:'Save Coder'})).toBeDisabled()
    first.unmount();render(<QueryClientProvider client={queryClient}><AgentDefaultsSettings /></QueryClientProvider>)
    await user.click(await screen.findByRole('button',{name:'Edit Operator defaults'}));expect(screen.getByRole('checkbox',{name:'Show Operator chat'})).not.toBeChecked()
    expect(screen.getByRole('button',{name:'Save Operator'})).toBeEnabled()
  })
})
