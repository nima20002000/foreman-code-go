import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

const identity = 'sha256:' + 'a'.repeat(64)
const folder = { name: 'Missing project', path: '/workspaces/Missing project', identity, deletion: { status: 'available' } }

it('shows unregistered workspace folders, confirms the exact path, retries safely and removes the deleted card', async () => {
  const user = userEvent.setup()
  let deleted = false
  const commands: unknown[] = []
  server.use(
    http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
      rootPath: '/workspaces', items: deleted ? [] : [folder], pageInfo: { nextCursor: null },
    })),
    http.post('/api/management/workspace-storage/folders/delete', async ({ request }) => {
      const body = await request.json()
      commands.push(body)
      if (commands.length === 1) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Connection interrupted' } }, { status: 503 })
      deleted = true
      return HttpResponse.json({ value: { path: folder.path }, replayed: true })
    }),
  )
  renderWithRouter(<WorkspaceDirectory />)
  const folders = await screen.findByRole('region', { name: 'Workspace folders on disk' })
  expect(within(folders).getByText('Missing project')).toBeVisible()
  expect(within(folders).getByText('Folder on disk · Not in the active workspace list')).toBeVisible()
  await user.click(within(folders).getByRole('button', { name: 'Delete folder' }))
  const confirmation = screen.getByRole('dialog', { name: 'Delete Missing project?' })
  expect(within(confirmation).getByText(folder.path)).toBeVisible()
  expect(confirmation).toHaveTextContent('all its files and subfolders')
  await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
  expect(commands).toHaveLength(0)
  await user.click(within(folders).getByRole('button', { name: 'Delete folder' }))
  await user.click(screen.getByRole('button', { name: 'Delete folder and contents' }))
  await user.click(await screen.findByRole('button', { name: 'Retry deletion' }))
  await waitFor(() => expect(screen.queryByText('Missing project')).not.toBeInTheDocument())
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  expect(commands[0]).toMatchObject({ path: folder.path, expectedIdentity: identity })
  expect(await screen.findByRole('link', { name: 'Website' })).toBeVisible()
})

it('keeps protected folders visible with a reason and unavailable deletion', async () => {
  const message = 'An archived workspace still references this folder. Its retained location is protected.'
  server.use(http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
    rootPath: '/workspaces', items: [{ ...folder, deletion: { status: 'protected', reason: 'archived_workspace', message } }],
    pageInfo: { nextCursor: null },
  })))
  renderWithRouter(<WorkspaceDirectory />)
  const folders = await screen.findByRole('region', { name: 'Workspace folders on disk' })
  expect(within(folders).getByText(folder.name)).toBeVisible()
  expect(within(folders).getByText(message)).toBeVisible()
  expect(within(folders).getByRole('button', { name: 'Delete folder' })).toBeDisabled()
})

it('loads more disk folders on request and shows a recoverable discovery error', async () => {
  const user = userEvent.setup()
  const requests: string[] = []
  let unavailable = true
  server.use(http.get('/api/management/workspace-storage/folders', ({ request }) => {
    if (unavailable) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Cannot read folders' } }, { status: 503 })
    const url = new URL(request.url)
    requests.push(url.search)
    return HttpResponse.json({ rootPath: '/workspaces', items: url.searchParams.has('cursor')
      ? [{ ...folder, name: 'Second project', path: '/workspaces/Second project' }] : [folder],
    pageInfo: { nextCursor: url.searchParams.has('cursor') ? null : folder.name } })
  }))
  renderWithRouter(<WorkspaceDirectory />)
  expect(await screen.findByText('Workspace folders unavailable')).toBeVisible()
  unavailable = false
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await user.click(await screen.findByRole('button', { name: 'Show more workspace folders' }))
  expect(await screen.findByText('Second project')).toBeVisible()
  expect(requests).toEqual(['?limit=5', '?limit=10&cursor=Missing+project'])
})
