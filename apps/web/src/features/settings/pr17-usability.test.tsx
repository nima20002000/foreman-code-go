// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, switchHarnessEditor, type HarnessEditor } from './harnessEditor'

const api = vi.hoisted(() => ({ presets: vi.fn(), check: vi.fn() }))
vi.mock('../../shared/api/query', () => ({ useHarnessDefaultsQuery: api.presets, useManagedHarnessCatalogQuery: () => ({ data: undefined }) }))
vi.mock('../../shared/api/harnessValidation', () => ({ useValidateHarnessConfiguration: () => useMutation({ mutationFn: api.check }) }))
vi.mock('./McpDetectionSettings', () => ({ McpDetectionSettings: () => null }))
const clients: QueryClient[] = []
beforeEach(() => {
  vi.clearAllMocks()
  api.presets.mockReturnValue({ data: { defaults: { ...DEFAULT_HARNESS_DEFAULTS, opencode: { ...DEFAULT_HARNESS_DEFAULTS.opencode, model: 'saved/custom-model' } } }, isPending: false, isError: false })
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function Editor({ initial = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex) }: { initial?: HarnessEditor }) {
  const [editor, setEditor] = useState(initial)
  return <HarnessConfigurationFields editor={editor} onChange={setEditor} />
}
function mount(initial?: HarnessEditor) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><Editor initial={initial} /></QueryClientProvider>)
}
describe('PR17 provider editing recovery', () => {
  it('preserves independent native drafts across harness switches', async () => {
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    await user.selectOptions(screen.getByLabelText('Sandbox'), 'workspace-write')
    await user.click(screen.getByRole('button', { name: 'Model & speed' }))
    await user.selectOptions(screen.getByLabelText('Harness'), 'opencode')
    expect(screen.getByLabelText('Model')).toHaveValue('saved/custom-model')
    await user.click(screen.getByLabelText('Show thinking'))
    await user.selectOptions(screen.getByLabelText('Harness'), 'codex')
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    expect(screen.getByLabelText('Sandbox')).toHaveValue('workspace-write')
    await user.click(screen.getByRole('button', { name: 'Model & speed' }))
    await user.selectOptions(screen.getByLabelText('Harness'), 'opencode')
    expect(screen.getByLabelText('Show thinking')).toBeChecked()
  })
  it('does not silently substitute built-in defaults when saved presets fail', () => {
    api.presets.mockReturnValue({ isPending: false, isError: true, refetch: vi.fn() })
    mount()
    expect(screen.getByRole('option', { name: 'OpenCode' })).toBeDisabled()
    expect(screen.getByText('Your draft is kept. Presets were not replaced.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Use built-in defaults/ })).toBeEnabled()
  })
  it('uses structured native MCP controls instead of the legacy JSON field', async () => {
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Tool permissions' }))
    expect(screen.getByRole('region', { name: 'Pinned MCP policy requirements' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'MCP connections' }))
    expect(screen.getByRole('region', { name: 'codex MCP connections' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Native MCP controls JSON')).not.toBeInTheDocument()
  })
  it('automatically qualifies the current native configuration', async () => {
    mount()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ready'))
  })
  it('has visible rule labels and keyboard-usable reorder controls with retained identity', async () => {
    const initial = structuredClone(DEFAULT_HARNESS_DEFAULTS.opencode)
    initial.advanced!.permissionRules = [{ permission: 'shell', pattern: '*', effect: 'deny' }, { permission: 'shell', pattern: 'git *', effect: 'ask' }]
    mount(createHarnessEditor(initial))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    const specific = screen.getByLabelText('Pattern 2')
    screen.getByRole('button', { name: 'Move permission rule 2 up' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('Pattern 1')).toBe(specific)
    expect(screen.getByLabelText('Pattern 1')).toHaveValue('git *')
    expect(screen.getByRole('button', { name: 'Move permission rule 1 up' })).toBeDisabled()
    expect(screen.getAllByText('Permission').length).toBe(2)
    expect(screen.getAllByText('Pattern').length).toBe(2)
    expect(screen.getAllByText('Decision').length).toBe(2)
  })
  it('serializes only the active provider, never its cached editor drafts', () => {
    const codex = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)
    const opencode = switchHarnessEditor(codex, 'opencode', DEFAULT_HARNESS_DEFAULTS.opencode)
    expect(opencode.drafts?.codex).toBeDefined()
    const prepared = prepareHarnessEditor(opencode)
    expect(prepared.harness).toBe('opencode')
    expect(prepared).not.toHaveProperty('drafts')
    expect(prepared).not.toHaveProperty('mcpText')
  })
})
