import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessBasicFields } from './HarnessBasicFields'
import { HostHarnessConfigurationFields } from './HostHarnessConfigurationFields'
import { createHarnessEditor } from './harnessEditor'

vi.mock('../../shared/api/harnessSettings', () => ({
  useNativeHarnessOptions: (harness: 'codex' | 'opencode') => ({ data: { models: [
    { id: DEFAULT_HARNESS_DEFAULTS[harness].model, name: 'Current native model', reasoningEfforts: ['medium', 'high'], variants: [''], serviceTiers: ['standard', 'priority'] },
    { id: 'long-model', name: 'A long native model label that remains searchable and selectable', reasoningEfforts: ['medium'], variants: ['balanced'], serviceTiers: ['standard'] },
  ], nativeAgents: ['build', 'plan'] }, isSuccess: true, isPending: false, isError: false, error: null }),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)
function BasicFields({ initial }: { initial: HarnessConfiguration }) {
  const [value, onChange] = useState(initial)
  return <HarnessBasicFields value={value} onChange={onChange} includeSandbox={false} />
}

it('keeps long model labels searchable by keyboard and retains supported effort choices', async () => {
  const user = userEvent.setup()
  render(<BasicFields initial={DEFAULT_HARNESS_DEFAULTS.codex} />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'high')
  const model = screen.getByRole('combobox', { name: 'Model' })
  await user.click(model)
  await user.type(model, 'long native model')
  await user.keyboard('{Enter}')
  expect(model).toHaveValue('A long native model label that remains searchable and selectable')
  expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('medium')
  expect(screen.getByRole('switch', { name: 'Fast mode' })).toBeDisabled()
})

it('allows an unavailable saved priority setting to be corrected through the compact switch', async () => {
  const user = userEvent.setup()
  render(<BasicFields initial={{ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'long-model', serviceTier: 'priority' }} />)
  const fast = screen.getByRole('switch', { name: 'Fast mode' })
  expect(fast).toBeChecked()
  expect(fast).toHaveAccessibleDescription('Not offered by this model. Turn Fast mode off.')
  await user.click(fast)
  expect(fast).not.toBeChecked()
  expect(fast).toBeDisabled()
  expect(screen.queryByText('Not offered by this model. Turn Fast mode off.')).not.toBeInTheDocument()
})

it.each(['codex', 'opencode'] as const)('updates the existing %s host configuration from its compact switch', async harness => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  const configuration = harness === 'codex' ? { ...DEFAULT_HARNESS_DEFAULTS.codex, serviceTier: 'standard' as const }
    : { ...DEFAULT_HARNESS_DEFAULTS.opencode, thinking: false }
  render(<HostHarnessConfigurationFields editor={createHarnessEditor(configuration)} onChange={onChange} />)
  await user.click(screen.getByRole('switch', { name: harness === 'codex' ? 'Fast mode' : 'Show thinking' }))
  expect(onChange.mock.calls[0]![0].configuration).toEqual({ ...configuration, ...(harness === 'codex' ? { serviceTier: 'priority' } : { thinking: true }) })
})

it('associates host service tier validation with the Fast mode switch', () => {
  render(<HostHarnessConfigurationFields editor={createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)} onChange={vi.fn()}
    issues={[{ path: ['serviceTier'], message: 'Choose a supported service tier.' }]} />)
  const fast = screen.getByRole('switch', { name: 'Fast mode' })
  expect(fast).toHaveAttribute('aria-invalid', 'true')
  expect(fast).toHaveAccessibleDescription('Choose a supported service tier.')
})
