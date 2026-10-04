import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from './harnessEditor'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'

vi.mock('../../shared/api/query', () => ({ useManagedHarnessCatalogQuery: () => ({ data: undefined }), useHarnessDefaultsQuery: () => ({ data: { defaults: DEFAULT_HARNESS_DEFAULTS } }) }))
vi.mock('../../shared/api/harnessValidation', () => ({ useValidateHarnessConfiguration: () => ({ data: undefined, mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }) }))
afterEach(cleanup)
function Editor({ value, save }: { value: HarnessConfiguration; save(value: HarnessConfiguration): void }) {
  const [editor, setEditor] = useState(() => createHarnessEditor(value))
  return <><HarnessConfigurationFields editor={editor} onChange={setEditor} /><button onClick={() => save(prepareHarnessEditor(editor))}>Store</button></>
}
function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('PR12 actual provider fields', () => {
  it('preserves server-vetted writable directory paths exactly', async () => {
    const user = userEvent.setup(); const save = vi.fn()
    const value = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    value.sandbox = 'workspace-write'
    value.advanced!.additionalWritableDirectories = ['/first/path ', '/second/path ']
    mount(<Editor value={value} save={save} />)
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    expect(screen.getByText('/first/path')).toBeInTheDocument()
    expect(screen.getByText('/second/path')).toBeInTheDocument()
    await user.click(screen.getByText('Store'))
    expect(save.mock.calls[0]![0].advanced.additionalWritableDirectories).toEqual(['/first/path ', '/second/path '])
  })
  it('keeps rule focus while typing and preserves order on removal', async () => {
    const user = userEvent.setup(); const save = vi.fn()
    mount(<Editor value={{ ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: undefined }} save={save} />)
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    await user.click(screen.getByText('Add custom rule'))
    const input = screen.getByLabelText('Permission 1')
    await user.clear(input); await user.type(input, 'custom-permission')
    expect(screen.getByLabelText('Permission 1')).toBe(input)
    expect(document.activeElement).toBe(input)
    await user.click(screen.getByText('Add custom rule'))
    const second = screen.getByLabelText('Permission 2')
    await user.click(screen.getByLabelText('Remove permission rule 1'))
    expect(screen.getByLabelText('Permission 1')).toBe(second)
    await user.click(screen.getByText('Store'))
    expect(save.mock.calls[0]![0].advanced.permissionRules).toEqual([{ permission: 'shell', pattern: '*', effect: 'ask' }])
  })
  it('round trips a custom model and variant when only the Agent name changes', async () => {
    const user = userEvent.setup(); const save = vi.fn()
    const configuration = { ...DEFAULT_HARNESS_DEFAULTS.opencode, model: 'custom/model', variant: 'budget-4096', nativeAgent: 'custom-worker' }
    mount(<AgentSettingsForm agent={{ id: 'a', name: 'Before', harness: 'opencode', harnessConfiguration: configuration }} onClose={() => {}} onSave={save} />)
    await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'After')
    await user.click(screen.getByLabelText('Save agent settings'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![0]).toMatchObject({ name: 'After', harnessConfiguration: configuration })
    expect(save.mock.calls[0]![0].effort).toBeUndefined()
  })
  it('repairs legacy native-auto coherently instead of losing the matching boolean', async () => {
    const user = userEvent.setup(); const save = vi.fn()
    mount(<Editor value={{ ...DEFAULT_HARNESS_DEFAULTS.opencode, advanced: undefined, autoApprove: true }} save={save} />)
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    await user.selectOptions(screen.getByLabelText('Permission handling'), 'graphql_routed')
    await user.click(screen.getByText('Store'))
    expect(save.mock.calls[0]![0]).toMatchObject({ autoApprove: false, advanced: { permissionHandling: 'graphql_routed' } })
  })
  it('preserves incomplete raw JSON until Save validates it', () => {
    const editor = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)
    editor.mcpText = '{'
    expect(() => prepareHarnessEditor(editor)).toThrow('Native MCP controls must contain valid JSON')
    expect(editor.mcpText).toBe('{')
  })
})
