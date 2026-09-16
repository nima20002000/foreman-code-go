// @vitest-environment jsdom
import { AgentSchema, DEFAULT_HARNESS_DEFAULTS, HarnessConfigurationSchema, type Agent } from '@graphql/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSettingsForm } from '../graph/GraphEditor'
import { configuredHarness, defaultAgentForHarness } from './agentSettings'

afterEach(cleanup)

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('PR8 exact native settings in the actual form', () => {
  it.each([false, true])('preserves a custom variant on a name-only save; creation=%s', (creating) => {
    const defaults = structuredClone(DEFAULT_HARNESS_DEFAULTS)
    defaults.opencode.variant = 'provider-custom-effort'
    defaults.opencode.model = 'provider/custom-model'
    const agent = defaultAgentForHarness('opencode', 'agent', 'Before', defaults.opencode)
    expect(agent.effort).toBeUndefined()
    const onSave = vi.fn()
    renderWithQueryClient(<AgentSettingsForm agent={agent} {...(creating ? { creationDefaults: defaults } : {})} onClose={() => undefined} onSave={onSave} />)
    expect((screen.getByLabelText('Provider variant') as HTMLInputElement).value).toBe('provider-custom-effort')
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('provider/custom-model')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'After' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    const saved = AgentSchema.parse(onSave.mock.calls[0]![0])
    expect(saved.name).toBe('After')
    expect(saved.effort).toBeUndefined()
    expect(saved.harnessConfiguration).toEqual(defaults.opencode)
  })

  it('changes a native variant only after an explicit selection', () => {
    const configuration = { ...DEFAULT_HARNESS_DEFAULTS.opencode, variant: 'provider-custom-effort' }
    const agent = defaultAgentForHarness('opencode', 'agent', 'Agent', configuration)
    const onSave = vi.fn()
    renderWithQueryClient(<AgentSettingsForm agent={agent} onClose={() => undefined} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Provider variant'), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave.mock.calls[0]![0]).toMatchObject({ effort: 'high', harnessConfiguration: { variant: 'high' } })
  })

  it.each(['read-only', 'danger-full-access'] as const)('explains and removes incompatible controls when changing to %s', (sandbox) => {
    const configuration = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    configuration.sandbox = 'workspace-write'
    configuration.advanced!.additionalWritableDirectories = ['/tmp/project-extra']
    configuration.advanced!.workspaceWrite = { networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    const agent = defaultAgentForHarness('codex', 'agent', 'Agent', configuration)
    const original = structuredClone(agent)
    const onSave = vi.fn()
    renderWithQueryClient(<AgentSettingsForm agent={agent} onClose={() => undefined} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Sandbox'), { target: { value: sandbox } })
    expect(screen.getByText(/Leaving workspace-write removes additional writable directories/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    const saved = onSave.mock.calls[0]![0] as Agent
    expect(HarnessConfigurationSchema.safeParse(saved.harnessConfiguration).success).toBe(true)
    expect(saved.harnessConfiguration).toMatchObject({ sandbox, advanced: { additionalWritableDirectories: [] } })
    expect(saved.harnessConfiguration?.harness === 'codex' ? saved.harnessConfiguration.advanced?.workspaceWrite : 'wrong harness').toBeUndefined()
    expect(agent).toEqual(original)
  })

  it('does not inherit later template edits into existing agent settings', () => {
    const template = structuredClone(DEFAULT_HARNESS_DEFAULTS.opencode)
    template.variant = 'copied-variant'
    const agent = defaultAgentForHarness('opencode', 'agent', 'Agent', template)
    template.variant = 'later-template-variant'
    expect(configuredHarness(agent, 'opencode', agent.model!, 'copied-variant', false, 'read-only'))
      .toMatchObject({ variant: 'copied-variant' })
  })
})
