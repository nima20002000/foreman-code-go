import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setMockScenario } from '../../shared/mocks/scenarios'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useWorkspaceLocationDraftStore } from './workspaceLocationDraftStore'
import { server } from '../../mocks/server'

const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId="workspace-1" /></QueryClientProvider>)
}
beforeEach(() => {
  useWorkspaceLocationDraftStore.getState().reset()
  setMockScenario('normal')
  server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? '/projects'
    return HttpResponse.json({
      roots: [{ id: '0', label: 'projects', path: '/projects' }], rootId: '0', path,
      parent: path === '/projects' ? null : '/projects', nextCursor: null,
      directories: path === '/projects' ? [{ name: 'My project', path: '/projects/My project' }] : [],
    })
  }))
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

describe('workspace execution folder picker', () => {
  it('opens from the field and saves inside the modal without an extra page button', async () => {
    const user = userEvent.setup()
    mount()
    const field = await screen.findByRole('button', { name: 'Project folder' })
    expect(screen.queryByRole('button', { name: 'Choose folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save location' })).not.toBeInTheDocument()
    await user.click(field)
    await user.click(await screen.findByRole('button', { name: 'My project' }))
    expect(await screen.findByText('No subfolders.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('/projects/My project')
    expect(field).toHaveFocus()
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-1']?.dirty).toBe(false)
  })

  it('goes Back to the previous folder without selecting or saving it', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    const back = await screen.findByRole('button', { name: 'Back' })
    expect(back).toBeDisabled()
    expect(back.closest('header')).toContainElement(screen.getByRole('heading', { name: 'Choose folder' }))
    await user.click(screen.getByRole('button', { name: 'My project' }))
    expect(await screen.findByText('No subfolders.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'My project' })).toBeVisible()
    expect(screen.getByText('/projects').parentElement).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-1']?.rootPath).toBe('')
  })

  it('keeps focus and Back available when a folder cannot be opened', async () => {
    server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
      if (new URL(request.url).searchParams.has('path')) return HttpResponse.json({
        error: { code: 'DIRECTORY_UNAVAILABLE', message: 'Folder unavailable.' },
      }, { status: 404 })
      return HttpResponse.json({ roots: [{ id: '0', label: 'projects', path: '/projects' }],
        rootId: '0', path: '/projects', parent: null, nextCursor: null,
        directories: [{ name: 'Unavailable', path: '/projects/Unavailable' }] })
    }))
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    await user.click(await screen.findByRole('button', { name: 'Unavailable' }))
    expect(await screen.findByText('Folder unavailable.')).toBeVisible()
    expect(screen.getByText('/projects/Unavailable').parentElement).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  })

  it('creates and saves a folder in one confirmation', async () => {
    const requests: unknown[] = []
    server.use(http.post('/api/management/harnesses/directories', async ({ request }) => {
      const input = await request.json() as { name: string; parentPath: string }
      requests.push(input)
      return HttpResponse.json({ value: { name: input.name, path: input.parentPath + '/' + input.name }, replayed: false })
    }))
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    await user.click(await screen.findByRole('button', { name: 'New folder' }))
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toHaveFocus()
    await user.type(screen.getByRole('textbox', { name: 'Folder name' }), 'New project')
    await user.click(screen.getByRole('button', { name: 'Create and use' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
    expect(requests).toEqual([expect.objectContaining({ name: 'New project', parentPath: '/projects', commandId: expect.any(String) })])
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-1']?.rootPath).toBe('/projects/New project')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
  })

  it('keeps a failed save in the modal for retry', async () => {
    server.use(http.put('/api/management/workspaces/:id/location', () => HttpResponse.json({
      error: { code: 'LOCATION_UNAVAILABLE', message: 'Folder no longer exists.' },
    }, { status: 422 })))
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    await user.click(await screen.findByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByRole('dialog')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Folder no longer exists.'))
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled()
  })

  it('retries saving the newly created folder without creating it again', async () => {
    let creates = 0
    let saves = 0
    server.use(
      http.post('/api/management/harnesses/directories', () => {
        creates++
        return HttpResponse.json({ value: { name: 'Project', path: '/projects/Project' }, replayed: false })
      }),
      http.put('/api/management/workspaces/:id/location', () => {
        saves++
        if (saves === 1) return HttpResponse.json({ error: { code: 'TEMPORARY', message: 'Try saving again.' } }, { status: 422 })
        const location = { runnerId: 'runner-local', rootPath: '/projects/Project' }
        return HttpResponse.json({ value: { workspaceId: 'workspace-1', executionLocation: location, locationRevision: 1,
          validation: { workspaceId: 'workspace-1', location, accessMode: 'read-only', checkedAt: new Date().toISOString() } }, replayed: false })
      }),
    )
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    await user.click(await screen.findByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Folder name' }), 'Project')
    await user.click(screen.getByRole('button', { name: 'Create and use' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try saving again.')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByText('Execution location saved. Future runs use this folder.')).toBeVisible()
    expect(creates).toBe(1)
    expect(saves).toBe(2)
  })

  it('keeps duplicate folder errors next to the name and preserves it', async () => {
    server.use(http.post('/api/management/harnesses/directories', () => HttpResponse.json({
      error: { code: 'DIRECTORY_EXISTS', message: 'A folder with this name already exists.' },
    }, { status: 409 })))
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    await user.click(await screen.findByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Folder name' }), 'Existing')
    await user.click(screen.getByRole('button', { name: 'Create and use' }))
    expect(await screen.findByText('A folder with this name already exists.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toHaveValue('Existing')
    expect(screen.getByRole('button', { name: 'Create and use' })).toBeEnabled()
  })

  it('cancels browsing without changing the saved location', async () => {
    const user = userEvent.setup()
    mount()
    const field = await screen.findByRole('button', { name: 'Project folder' })
    await user.click(field)
    await user.click(await screen.findByRole('button', { name: 'My project' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field).toHaveTextContent('Choose a folder')
    expect(field).toHaveFocus()
  })
})
