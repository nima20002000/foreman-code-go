import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { it, expect, vi } from 'vitest'
import { HostHarnessConfigurationFields } from './HostHarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from './harnessEditor'
import { validationIssues } from './fieldValidation'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

function renderClaudeFields(props: Parameters<typeof HostHarnessConfigurationFields>[0]) {
  const client = new QueryClient()
  return render(<HostHarnessConfigurationFields {...props} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}

it.each([
  ['read-only', 'Read only'],
  ['workspace-write', 'Workspace write'],
  ['danger-full-access', 'Full access'],
] as const)('shows the exact stored Claude sandbox %s without modifying the profile', (sandbox, label) => {
  const configuration = { ...savedClaudeConfiguration, sandbox }
  const editor = createHarnessEditor(configuration)
  const onChange = vi.fn()
  renderClaudeFields({ editor, onChange })
  const field = screen.getByRole('combobox', { name: 'Sandbox' })
  expect(field).toHaveValue(sandbox)
  expect(field).toHaveDisplayValue(label)
  expect(onChange).not.toHaveBeenCalled()
  expect(prepareHarnessEditor(editor)).toEqual(configuration)
})

it('retains the explicit supported Claude sandbox selection through prepared save and readback', () => {
  const onChange = vi.fn()
  const view = renderClaudeFields({ editor: createHarnessEditor(savedClaudeConfiguration), onChange })
  for (const sandbox of ['danger-full-access', 'workspace-write', 'read-only'] as const) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Sandbox' }), { target: { value: sandbox } })
    const saved = prepareHarnessEditor(onChange.mock.calls.at(-1)![0])
    expect(saved).toEqual({ ...savedClaudeConfiguration, sandbox })
    view.rerender(<HostHarnessConfigurationFields editor={createHarnessEditor(saved)} onChange={onChange} />)
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveValue(sandbox)
  }
})

it.each([
  ['codex', 'Model', 'model'],
  ['opencode', 'Model', 'model'],
  ['opencode', 'Provider variant', 'variant'],
  ['opencode', 'Native Agent', 'nativeAgent'],
  ['codex', 'Shell environment policy · JSON', 'advanced.shellEnvironment'],
  ['codex', 'Pinned MCP policy · JSON', 'advanced.mcpServers'],
  ['opencode', 'Pinned MCP policy · JSON', 'advanced.mcp'],
] as const)('associates %s %s errors with their control and clears them with corrected readback', (harness, label, path) => {
  const editor = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS[harness])
  const onChange = vi.fn()
  const message = 'Correct this saved configuration field.'
  const view = render(<HostHarnessConfigurationFields editor={editor} onChange={onChange} issues={[{ path: path.split('.'), message }]} />)
  const field = screen.getByRole('textbox', { name: label })
  expect(field).toHaveAttribute('aria-invalid', 'true')
  expect(field).toHaveAccessibleDescription(expect.stringContaining(message))
  expect(screen.getByText(message)).toBeVisible()
  fireEvent.change(field, { target: { value: 'corrected' } })
  expect(onChange).toHaveBeenCalledTimes(1)
  view.rerender(<HostHarnessConfigurationFields editor={onChange.mock.calls[0]![0]} onChange={onChange} issues={[]} />)
  expect(field).not.toHaveAttribute('aria-invalid', 'true')
  expect(field).not.toHaveAccessibleDescription(expect.stringContaining(message))
  expect(screen.queryByText(message)).not.toBeInTheDocument()
})

it.each(['shellEnvironmentText', 'mcpText'] as const)('connects the actual malformed %s validation error to its JSON editor', field => {
  const editor = { ...createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex), [field]: '{broken' }
  let issues: ReturnType<typeof validationIssues> = []
  try { prepareHarnessEditor(editor) } catch (error) { issues = validationIssues(error) }
  expect(issues).toHaveLength(1)
  render(<HostHarnessConfigurationFields editor={editor} onChange={vi.fn()} issues={issues} />)
  const label = field === 'shellEnvironmentText' ? 'Shell environment policy · JSON' : 'Pinned MCP policy · JSON'
  expect(screen.getByRole('textbox', { name: label })).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('textbox', { name: label })).toHaveAccessibleDescription(expect.stringContaining(issues[0]!.message))
})
