import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'

import { resetMockScenario } from '../../shared/mocks/control'
import { queryKeys } from '../../shared/api/query'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useWorkspaceLocationDraftStore } from './workspaceLocationDraftStore'
import { server } from '../../mocks/server'

const clients: QueryClient[] = []

function renderLocation() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  const rendered = render(
    <QueryClientProvider client={client}>
      <WorkspaceExecutionLocationSettings workspaceId="workspace-1" />
    </QueryClientProvider>,
  )
  return { client, ...rendered }
}

beforeEach(async () => {
  useWorkspaceLocationDraftStore.getState().reset()
  await resetMockScenario()
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe('workspace execution location settings', () => {
  it('validates, saves and reloads the canonical runner path', async () => {
    const user = userEvent.setup()
    const first = renderLocation()
    const path = await screen.findByRole('textbox', { name: 'Execution folder path' })
    expect(screen.getByText('No execution location is configured. New runs are disabled.')).toBeVisible()
    await user.type(path, '/tmp/project with spaces/ü')
    await user.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByText('Location is valid on Local Runner.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
    first.unmount()
    first.client.clear()

    renderLocation()
    expect(await screen.findByRole('textbox', { name: 'Execution folder path' })).toHaveValue('/tmp/project with spaces/ü')
    expect(screen.getByText('Ready on Local Runner.')).toBeVisible()
  })

  it('preserves unsaved text when an external location revision arrives', async () => {
    const user = userEvent.setup()
    const { client } = renderLocation()
    const path = await screen.findByRole('textbox', { name: 'Execution folder path' })
    await user.type(path, '/tmp/local edit')

    act(() => client.setQueryData(queryKeys.managedWorkspace('workspace-1'), {
      workspace: { id: 'workspace-1', name: 'Website' }, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/external' },
      locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: new Date().toISOString() },
    }))

    await waitFor(() => expect(screen.getByText(/saved location changed elsewhere/i)).toBeVisible())
    expect(path).toHaveValue('/tmp/local edit')
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled()
  })

  it('preserves a newer edit made while Save is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.put('/api/management/workspaces/:workspaceId/location', async () => {
      await gate
      const checkedAt = new Date().toISOString()
      return HttpResponse.json({
        value: {
          workspaceId: 'workspace-1',
          executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/submitted' },
          locationRevision: 1,
          validation: {
            workspaceId: 'workspace-1', location: { runnerId: 'runner-local', rootPath: '/tmp/submitted' },
            accessMode: 'read-only', checkedAt,
          },
        },
        replayed: false,
      })
    }))
    const user = userEvent.setup()
    renderLocation()
    const path = await screen.findByRole('textbox', { name: 'Execution folder path' })
    await user.type(path, '/tmp/submitted')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    await user.clear(path)
    await user.type(path, '/tmp/newer edit')

    release()

    expect(await screen.findByText('Execution location saved. Your newer path remains unsaved.')).toBeVisible()
    expect(path).toHaveValue('/tmp/newer edit')
    expect(screen.getByText('Unsaved location change.')).toBeVisible()
  })
})
