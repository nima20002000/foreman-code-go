import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'

type SaveDefaults = ReturnType<typeof import('../../shared/api/query').useSaveHarnessDefaultsMutation>['mutateAsync']
type SaveInput = Parameters<SaveDefaults>[0]
type SaveResponse = Awaited<ReturnType<SaveDefaults>>
const { saveDefaults } = vi.hoisted(() => ({ saveDefaults: vi.fn<SaveDefaults>() }))

vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return {
    ...actual,
    useSaveHarnessDefaultsMutation: () => useMutation({ mutationFn: (input: SaveInput) => saveDefaults(input) }),
  }
})

const clients: QueryClient[] = []

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.harnessDefaults, { defaults: DEFAULT_HARNESS_DEFAULTS })
  clients.push(client)
  render(<QueryClientProvider client={client}><HarnessDefaultsSettings /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  saveDefaults.mockReset()
  saveDefaults.mockImplementation(async (input) => ({ defaults: input.defaults }))
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  clearRevisionedFormPersistence()
})

describe('PR #3 defaults form regressions', () => {
  it('preserves newer edits made while a save is pending', async () => {
    let resolve!: (response: SaveResponse) => void
    const pending = new Promise<SaveResponse>((done) => { resolve = done })
    saveDefaults.mockImplementationOnce(() => pending)
    renderSettings()
    const user = userEvent.setup()
    const sandbox = await screen.findByRole('combobox', { name: 'Sandbox' })
    await user.selectOptions(sandbox, 'workspace-write')
    await user.click(screen.getByRole('button', { name: 'Save defaults' }))
    await waitFor(() => expect(saveDefaults).toHaveBeenCalledOnce())
    await user.selectOptions(sandbox, 'read-only')
    expect(sandbox).toHaveValue('read-only')
    const submitted = saveDefaults.mock.calls[0]![0]
    await act(async () => {
      resolve({ defaults: submitted.defaults })
      await pending
    })
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument()
    expect(sandbox).toHaveValue('read-only')
  })

  it('does not overwrite a local edit when the defaults query refreshes', async () => {
    const client = renderSettings()
    const user = userEvent.setup()
    const sandbox = await screen.findByRole('combobox', { name: 'Sandbox' })
    await user.selectOptions(sandbox, 'workspace-write')
    act(() => client.setQueryData(queryKeys.harnessDefaults, {
      defaults: {
        ...DEFAULT_HARNESS_DEFAULTS,
        codex: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'gpt-5.6-terra' },
      },
    }))
    await waitFor(() => expect(screen.getByText('Unsaved changes.')).toBeInTheDocument())
    expect(sandbox).toHaveValue('workspace-write')
    expect(within(screen.getByRole('group', { name: 'Codex' })).getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.6-luna')
  })

  it('repairs legacy native auto-approval and never submits it as enabled', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.harnessDefaults, { defaults: {
      ...DEFAULT_HARNESS_DEFAULTS,
      opencode: {
        ...DEFAULT_HARNESS_DEFAULTS.opencode,
        autoApprove: true,
        advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!, permissionHandling: 'native_auto' as const },
      },
    } })
    clients.push(client)
    render(<QueryClientProvider client={client}><HarnessDefaultsSettings /></QueryClientProvider>)
    const permissionHandling = await screen.findByRole('combobox', { name: 'Permission handling' })
    expect(within(permissionHandling).getByRole('option', { name: /Native auto approve/ })).toBeDisabled()
    await userEvent.setup().selectOptions(permissionHandling, 'graphql_routed')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save defaults' }))
    await waitFor(() => expect(saveDefaults).toHaveBeenCalledOnce())
    expect(saveDefaults.mock.calls[0]![0].defaults.opencode.autoApprove).toBe(false)
  })
})
