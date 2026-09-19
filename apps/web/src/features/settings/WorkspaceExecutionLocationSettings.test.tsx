import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'

import { setMockScenario } from '../../shared/mocks/scenarios'
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

beforeEach(() => {
  useWorkspaceLocationDraftStore.getState().reset()
  setMockScenario('normal')
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe('workspace execution location settings', () => {
  it('browses a workspace folder without typing and saves it for future runs', async () => {
    server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '/projects'
      return HttpResponse.json({
        roots: [{ id: '0', label: 'projects', path: '/projects' }], rootId: '0', path,
        parent: path === '/projects' ? null : '/projects', nextCursor: null,
        directories: path === '/projects' ? [{ name: 'My project', path: '/projects/My project' }] : [],
      })
    }))
    const user = userEvent.setup()
    renderLocation()
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
    await user.click(await screen.findByRole('button', { name: /My project/ }))
    expect(await screen.findByText('No subfolders. You can use this folder.')).toBeVisible()
    expect(screen.getByText('/projects/My project')).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(screen.getByRole('textbox', { name: 'Execution folder path' })).toHaveValue('/projects/My project')
    expect(screen.getByRole('button', { name: 'Choose folder' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
  })

  it('does not allow selecting a pending or empty listing', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get('/api/management/harnesses/directories', async () => {
      await pending
      return HttpResponse.json({ roots: [], rootId: null, path: null, parent: null, directories: [], nextCursor: null })
    }))
    const user = userEvent.setup()
    renderLocation()
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
    expect(await screen.findByText('Loading folders…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
    release()
    expect(await screen.findByText(/No folders are available to browse/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled()
  })

  it('preserves a draft on cancel and prevents selecting failed listings', async () => {
    server.use(http.get('/api/management/harnesses/directories', () =>
      HttpResponse.json({ error: { code: 'DIRECTORY_UNAVAILABLE', message: 'Folder unavailable' } }, { status: 403 })))
    const user = userEvent.setup()
    renderLocation()
    const path = await screen.findByRole('textbox', { name: 'Execution folder path' })
    await user.type(path, '/existing/draft')
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(path).toHaveValue('/existing/draft')
    expect(screen.getByRole('button', { name: 'Choose folder' })).toHaveFocus()
  })

  it('saves and reloads the canonical runner path', async () => {
    const user = userEvent.setup()
    const first = renderLocation()
    const path = await screen.findByRole('textbox', { name: 'Execution folder path' })
    expect(screen.queryByRole('textbox', { name: 'Execution runner' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Validate' })).not.toBeInTheDocument()
    await user.type(path, '/tmp/project with spaces/ü')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
    first.unmount()
    first.client.clear()

    renderLocation()
    expect(await screen.findByRole('textbox', { name: 'Execution folder path' })).toHaveValue('/tmp/project with spaces/ü')
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled()
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
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled()
  })
})
