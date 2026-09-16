import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { AgentDefaultsSettings } from './AgentDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'

const { updateDefaults } = vi.hoisted(() => ({ updateDefaults: vi.fn() }))
vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return { ...actual, useUpdateAgentDefaultsMutation: () => useMutation({ mutationFn: updateDefaults }) }
})

afterEach(() => { cleanup(); clearRevisionedFormPersistence() })

describe('Agent defaults settings', () => {
  it('keeps role templates distinct and exposes the Operator UI flag without enabling board insertion', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.agentDefaults, { value: DEFAULT_AGENT_DEFAULTS, revision: 3, versionId: 'agents-v3' })
    updateDefaults.mockImplementation(async (input) => ({ value: { value: input.value, revision: 4, versionId: 'agents-v4' }, replayed: false }))
    render(<QueryClientProvider client={client}><AgentDefaultsSettings /></QueryClientProvider>)
    expect(await screen.findByRole('heading', { name: 'Orchestrator' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Coder' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Operator' })).toBeVisible()
    expect(screen.getByText('Application Agent · Board insertion forbidden')).toBeVisible()
    const toggle = screen.getByRole('checkbox', { name: /Enable Operator UI/ })
    await userEvent.setup().click(toggle)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save defaults' }))
    await waitFor(() => expect(updateDefaults).toHaveBeenCalled())
    expect(updateDefaults.mock.calls[0]![0]).toEqual(expect.objectContaining({ expectedRevision: 3 }))
    expect(updateDefaults.mock.calls[0]![0].value.operator.uiEnabled).toBe(false)
  })

  it('preserves ordered OpenCode custom rules in Advanced', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.agentDefaults, { value: {
      ...DEFAULT_AGENT_DEFAULTS,
      coder: { ...DEFAULT_AGENT_DEFAULTS.coder, harness: { ...DEFAULT_HARNESS_DEFAULTS.opencode,
        advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!, permissionRules: [
          { permission: 'shell', pattern: 'git *', effect: 'ask' as const },
          { permission: 'shell', pattern: '*', effect: 'deny' as const },
        ] } } },
    }, revision: 1, versionId: 'agents-v1' })
    render(<QueryClientProvider client={client}><AgentDefaultsSettings /></QueryClientProvider>)
    const advanced = screen.getAllByText('Advanced')[1]!
    await userEvent.setup().click(advanced)
    expect(screen.getByRole('textbox', { name: 'Pattern 1' })).toHaveValue('git *')
    expect(screen.getByRole('textbox', { name: 'Pattern 2' })).toHaveValue('*')
    expect(screen.getByText(/Rules retain order and patterns exactly/i)).toBeVisible()
  })

  it('preserves an unsent Operator visibility draft across navigation-style unmounts', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.agentDefaults, { value: DEFAULT_AGENT_DEFAULTS, revision: 2, versionId: 'agents-v2' })
    const first = render(<QueryClientProvider client={client}><AgentDefaultsSettings /></QueryClientProvider>)
    const toggle = await screen.findByRole('checkbox', { name: /Enable Operator UI/ })
    await userEvent.setup().click(toggle)
    first.unmount()
    render(<QueryClientProvider client={client}><AgentDefaultsSettings /></QueryClientProvider>)
    expect(await screen.findByRole('checkbox', { name: /Enable Operator UI/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeEnabled()
  })
})
