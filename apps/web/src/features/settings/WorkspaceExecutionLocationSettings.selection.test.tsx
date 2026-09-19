import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ManagedWorkspace } from '@graphql/contracts/management'

import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useWorkspaceLocationDraftStore } from './workspaceLocationDraftStore'

const checkedAt = '2026-09-19T00:00:00Z'
const saved: ManagedWorkspace = {
  workspace: { id: 'workspace-select', name: 'Selection test' }, revision: 1, archivedAt: null,
  executionLocation: { runnerId: 'runner-local', rootPath: '/projects' }, locationRevision: 1,
  locationValidation: { status: 'ready', checkedAt },
}
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace-select'), saved)
  render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId="workspace-select" /></QueryClientProvider>)
  return client
}
function response(rootPath: string) {
  const location = { runnerId: 'runner-local', rootPath }
  return { value: { workspaceId: 'workspace-select', executionLocation: location, locationRevision: 2,
    validation: { workspaceId: 'workspace-select', location, accessMode: 'read-only', checkedAt } }, replayed: false }
}
async function chooseChild() {
  const user = userEvent.setup()
  const field = await screen.findByRole('button', { name: 'Project folder' })
  await user.click(field)
  await user.click(await screen.findByRole('button', { name: 'Child' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
  return { user, field }
}
beforeEach(() => {
  useWorkspaceLocationDraftStore.getState().reset()
  server.use(
    http.get('/api/management/workspaces/workspace-select', () => HttpResponse.json(saved)),
    http.get('/api/management/harnesses/directories', ({ request }) => HttpResponse.json({
      roots: [{ id: 'projects', label: 'Projects', path: '/projects' }], rootId: 'projects', path: new URL(request.url).searchParams.get('path') ?? '/projects',
      parent: new URL(request.url).searchParams.get('path') === '/projects/Child' ? '/projects' : null, nextCursor: null, directories: [{ name: 'Child', path: '/projects/Child' }],
    })),
  )
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

describe('destination confirmation owns persistence', () => {
  it('copies the accepted destination without opening the picker', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByRole('button', { name: 'Project folder' })
    expect(screen.queryByText('Change folder')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Copy folder path' }))
    expect(await navigator.clipboard.readText()).toBe('/projects')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps highlighting local and Cancel preserves the page value without any write', async () => {
    const writes: unknown[] = []
    server.use(http.put('/api/management/workspaces/workspace-select/location', async ({ request }) => {
      writes.push(await request.json()); return HttpResponse.json(response('/projects/Child'))
    }))
    mount()
    const { user, field } = await chooseChild()
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(field.parentElement).not.toHaveTextContent('/projects/Child')
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(field).toHaveFocus()
    expect(writes).toEqual([])
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-select']?.dirty).toBe(false)
  })

  it('waits for acknowledgement, then shows the destination in the original field', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writes: Record<string, unknown>[] = []
    server.use(http.put('/api/management/workspaces/workspace-select/location', async ({ request }) => {
      writes.push(await request.json() as Record<string, unknown>); await gate
      return HttpResponse.json(response('/projects/Child'))
    }))
    const client = mount()
    client.setQueryData(queryKeys.managedWorkspaces, { items: [saved], pageInfo: { nextCursor: null } })
    const { user, field } = await chooseChild()
    try {
      await user.click(screen.getByRole('button', { name: 'Select location' }))
      await waitFor(() => expect(writes).toHaveLength(1))
      expect(field.parentElement).not.toHaveTextContent('/projects/Child')
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    } finally { await act(async () => { release(); await gate }) }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(field.parentElement).toHaveTextContent('/projects/Child')
    expect(field).toHaveFocus()
    expect(client.getQueryState(queryKeys.managedWorkspaces)?.isInvalidated).toBe(true)
    expect(writes[0]).toMatchObject({ rootPath: '/projects/Child', expectedLocationRevision: 1, commandId: expect.any(String) })
  })

  it('keeps the saved field intact after rejection and allows Cancel', async () => {
    server.use(http.put('/api/management/workspaces/workspace-select/location', () => HttpResponse.json({
      error: { code: 'LOCATION_UNAVAILABLE', message: 'Destination unavailable.' },
    }, { status: 422 })))
    mount()
    const { user, field } = await chooseChild()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Destination unavailable.')
    expect(field.parentElement).not.toHaveTextContent('/projects/Child')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-select']?.dirty).toBe(false)
  })

  it('retries an uncertain save with the same destination, revision and command identity', async () => {
    const writes: Record<string, unknown>[] = []
    server.use(http.put('/api/management/workspaces/workspace-select/location', async ({ request }) => {
      writes.push(await request.json() as Record<string, unknown>)
      return writes.length === 1
        ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save not confirmed.' } }, { status: 503 })
        : HttpResponse.json(response('/projects/Child'))
    }))
    mount()
    const { user, field } = await chooseChild()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await screen.findByText('Saving could not be confirmed. Retry Select location to resolve the same request.')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(field.parentElement).not.toHaveTextContent('/projects/Child')
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(field.parentElement).toHaveTextContent('/projects/Child')
  })

  it('accepts the already-saved ready folder without a redundant write', async () => {
    let writes = 0
    server.use(http.put('/api/management/workspaces/workspace-select/location', () => {
      writes++; return HttpResponse.json(response('/projects'))
    }))
    mount()
    const user = userEvent.setup()
    const field = await screen.findByRole('button', { name: 'Project folder' })
    await user.click(field)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toBe(0)
    expect(field).toHaveFocus()
  })
})
