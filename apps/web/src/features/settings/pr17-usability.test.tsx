// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
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
  it('preserves invalid raw JSON and independent model edits across harness switches', async () => {
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByText('Advanced'))
    fireEvent.change(screen.getByLabelText('Native MCP controls JSON'), { target: { value: '{' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'codex/local-draft' } })
    await user.selectOptions(screen.getByLabelText('Harness'), 'opencode')
    expect(screen.getByLabelText('Model')).toHaveValue('saved/custom-model')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opencode/local-draft' } })
    await user.selectOptions(screen.getByLabelText('Harness'), 'codex')
    expect(screen.getByLabelText('Model')).toHaveValue('codex/local-draft')
    expect(screen.getByLabelText('Native MCP controls JSON')).toHaveValue('{')
    await user.selectOptions(screen.getByLabelText('Harness'), 'opencode')
    expect(screen.getByLabelText('Model')).toHaveValue('opencode/local-draft')
  })
  it('does not silently substitute built-in defaults when saved presets fail', () => {
    api.presets.mockReturnValue({ isPending: false, isError: true, refetch: vi.fn() })
    mount()
    expect(screen.getByRole('option', { name: 'OpenCode' })).toBeDisabled()
    expect(screen.getByText(/built-in defaults will not be substituted/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /use built-in defaults/ })).toBeEnabled()
  })
  it('attaches JSON validation to its field, opens Advanced, and focuses it', async () => {
    mount({ ...createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex), mcpText: '{' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check selected configuration' }))
    const input = screen.getByLabelText('Native MCP controls JSON')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toHaveTextContent('must contain valid JSON')
    expect(input.closest('details')).toHaveAttribute('open')
    await waitFor(() => expect(input).toHaveFocus())
    expect(api.check).not.toHaveBeenCalled()
  })
  it('hides the old native check failure after the configuration changes', async () => {
    api.check.mockRejectedValue(new Error('The checked model is unavailable'))
    mount()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check selected configuration' }))
    expect(await screen.findByText('The checked model is unavailable')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'new/model' } })
    expect(screen.queryByText('The checked model is unavailable')).not.toBeInTheDocument()
    expect(screen.getByText(/^Not checked\./)).toBeInTheDocument()
  })
  it('has visible rule labels and keyboard-usable reorder controls with retained identity', async () => {
    const initial = structuredClone(DEFAULT_HARNESS_DEFAULTS.opencode)
    initial.advanced!.permissionRules = [{ permission: 'shell', pattern: '*', effect: 'deny' }, { permission: 'shell', pattern: 'git *', effect: 'ask' }]
    mount(createHarnessEditor(initial))
    const user = userEvent.setup()
    await user.click(screen.getByText('Advanced'))
    const specific = screen.getByLabelText('Pattern 2')
    screen.getByRole('button', { name: 'Move permission rule 2 up' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('Pattern 1')).toBe(specific)
    expect(screen.getByLabelText('Pattern 1')).toHaveValue('git *')
    expect(screen.getByRole('button', { name: 'Move permission rule 1 up' })).toBeDisabled()
    expect(screen.getAllByText('Permission').length).toBe(2)
    expect(screen.getAllByText('Pattern').length).toBe(2)
    expect(screen.getAllByText('Effect').length).toBe(2)
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
