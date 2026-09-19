import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFolderCreateInput } from '@graphql/contracts/management'

import { server } from '../../mocks/server'
import { harnessSettingsKeys, type useHarnessDirectories } from '../../shared/api/harnessSettings'
import { setMockScenario } from '../../shared/mocks/scenarios'
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'

type DirectoryPage = NonNullable<ReturnType<typeof useHarnessDirectories>['data']>
const root = { id: 'projects', label: 'Projects', path: '/projects' }
function page(overrides: Partial<DirectoryPage> = {}): DirectoryPage {
  return {
    roots: [root], rootId: root.id, path: root.path, parent: null, nextCursor: null,
    directories: [{ name: 'Project', path: '/projects/Project' }], ...overrides,
  }
}
const clients: QueryClient[] = []
function mount(onSelect = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined), selectionUnconfirmed = false, value = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><WorkspaceFolderPicker disabled={false} value={value} onSelect={onSelect} selectionUnconfirmed={selectionUnconfirmed} /></QueryClientProvider>)
  return { client, onSelect }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Project folder' }))
  await user.click(await screen.findByRole('button', { name: 'Open Projects' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
}
beforeEach(() => {
  setMockScenario('normal')
  server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? root.path
    return HttpResponse.json(path === root.path ? page() : page({ path, parent: root.path, directories: [] }))
  }))
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

describe('WorkspaceFolderPicker Nocturne layout and interaction', () => {
  it('opens Locations with the saved destination on top and updates it during browsing and Back', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount(undefined, false, '/projects/Current')
    await user.click(screen.getByRole('button', { name: 'Project folder' }))
    expect(await screen.findByRole('list', { name: 'Locations' })).toBeVisible()
    const destination = () => screen.getByRole('textbox', { name: 'Destination' })
    expect(destination()).toHaveValue('/projects/Current')
    expect(screen.queryByRole('list', { name: 'Folders' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('dialog').querySelector('footer')).not.toContainElement(destination())
    await user.click(screen.getByRole('button', { name: 'Open Projects' }))
    expect(await screen.findByRole('list', { name: 'Folders' })).toBeVisible()
    expect(destination()).toHaveValue('/projects')
    await user.click(screen.getByRole('button', { name: 'Open Project' }))
    await waitFor(() => expect(destination()).toHaveValue('/projects/Project'))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toBeVisible()
    expect(destination()).toHaveValue('/projects')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('list', { name: 'Locations' })).toBeVisible()
    expect(destination()).toHaveValue('/projects/Current')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('uses a named folder list, a visible creation action, and a separate confirmation footer', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    const dialog = screen.getByRole('dialog', { name: 'Choose folder' })
    const list = within(dialog).getByRole('list', { name: 'Folders' })
    expect(within(list).getByRole('button', { name: 'Project' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'New folder' })).toHaveTextContent('New folder')
    expect(within(dialog).getByRole('button', { name: 'Back' }).closest('header')).toContainElement(
      within(dialog).getByRole('heading', { name: 'Choose folder' }),
    )
    const footer = within(dialog).getByRole('button', { name: 'Select folder' }).closest('footer')
    expect(footer).toContainElement(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(footer).not.toContainElement(list)
    expect(within(dialog).queryByRole('combobox', { name: 'Location' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not call a folder empty when only its subfolder listing is known', async () => {
    server.use(http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories: [] }))))
    const user = userEvent.setup()
    mount()
    await openPicker(user)
    expect(screen.queryByText('Empty folder')).not.toBeInTheDocument()
    expect(screen.queryByText('No subfolders.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled()
  })

  it.each(['Back', 'Escape'] as const)('returns focus to New folder after leaving the inline editor with %s', async (action) => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const input = screen.getByRole('textbox', { name: 'Folder name' })
    expect(input).toHaveFocus()
    await user.type(input, 'Unsubmitted folder')
    if (action === 'Back') await user.click(screen.getByRole('button', { name: 'Back' }))
    else await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'New folder' })).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Choose folder' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not move focus from Cancel when the directory query refreshes', async () => {
    const user = userEvent.setup()
    const { client } = mount()
    await openPicker(user)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    act(() => cancel.focus())
    await act(async () => { await client.refetchQueries({ queryKey: harnessSettingsKeys.root }) })
    expect(cancel).toHaveFocus()
  })

  it('keeps root changes and paginated browsing reversible without committing a selection', async () => {
    const archive = { id: 'archive', label: 'Archive', path: '/archive' }
    const roots = [root, archive]
    const reads: Array<{ rootId: string | null; path: string | null; cursor: string | null }> = []
    server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
      const query = new URL(request.url).searchParams
      reads.push({ rootId: query.get('rootId'), path: query.get('path'), cursor: query.get('cursor') })
      if (query.get('rootId') === archive.id) return HttpResponse.json(page({ roots, rootId: archive.id, path: archive.path, directories: [] }))
      if (query.get('path') === '/projects/Zeta') return HttpResponse.json(page({ roots, path: '/projects/Zeta', parent: root.path, directories: [] }))
      if (query.get('cursor') === 'page-2') return HttpResponse.json(page({ roots, directories: [{ name: 'Zeta', path: '/projects/Zeta' }] }))
      return HttpResponse.json(page({ roots, nextCursor: 'page-2' }))
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Next folders' }))
    await user.dblClick(await screen.findByRole('button', { name: 'Zeta' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('button', { name: 'Zeta' })
    await user.click(screen.getByRole('button', { name: 'Locations' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('list', { name: 'Locations' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Zeta' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(reads).toContainEqual({ rootId: root.id, path: root.path, cursor: 'page-2' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps an uncertain creation locked but allows retry with the original command identity', async () => {
    const writes: WorkspaceFolderCreateInput[] = []
    server.use(http.post('/api/management/harnesses/directories', async ({ request }) => {
      writes.push(await request.json() as WorkspaceFolderCreateInput)
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Creation could not be confirmed.' } }, { status: 503 })
      return HttpResponse.json({ value: { name: 'New project', path: '/projects/New project' }, replayed: true })
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Folder name' }), 'New project')
    await user.click(screen.getByRole('button', { name: 'Create and select' }))
    await screen.findByText('Creation could not be confirmed. Retry with the same name.')
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Folder name' })).toHaveValue('New project')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create and select' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Create and select' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/New project'))
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ parentPath: root.path, name: 'New project', commandId: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the modal open and blocks competing actions until saving finishes', async () => {
    const gate = deferred()
    const onSelect = vi.fn<(path: string) => Promise<void>>().mockReturnValue(gate.promise)
    const user = userEvent.setup()
    mount(onSelect)
    await openPicker(user)
    try {
      await user.click(screen.getByRole('button', { name: 'Select folder' }))
      expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Project' })).toBeDisabled()
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(root.path)
    } finally { await act(async () => { gate.resolve(); await gate.promise }) }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Project folder' })).toHaveFocus()
  })

  it('resets browser history on reopen and keeps cancellation read-only', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.dblClick(screen.getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await openPicker(user)
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Project' })).toBeVisible()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects a child with one click without browsing, then confirms that exact destination', async () => {
    const reads: string[] = []
    server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
      reads.push(new URL(request.url).searchParams.get('path') ?? root.path)
      return HttpResponse.json(page())
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    const folder = screen.getByRole('button', { name: 'Project' })
    await user.click(folder)
    expect(folder).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(reads).toEqual([root.path, root.path])
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects/Project')
    await user.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/Project'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('double-clicks into a folder without confirming it', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.dblClick(screen.getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/Project'))
  })

  it('offers single-activation Open for touch and keyboard users', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    const folder = screen.getByRole('button', { name: 'Project' })
    act(() => folder.focus())
    await user.keyboard(' ')
    expect(folder).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Open Project' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Project' })).not.toBeInTheDocument())
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not change the candidate when focus moves to another row', async () => {
    server.use(http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories: [
      { name: 'Project', path: '/projects/Project' }, { name: 'Other', path: '/projects/Other' },
    ] }))))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Project' }))
    act(() => screen.getByRole('button', { name: 'Other' }).focus())
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Other' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/Project'))
  })

  it('keeps a selected folder editable after a definitive save rejection', async () => {
    const onSelect = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Destination rejected.')).mockResolvedValue(undefined)
    const user = userEvent.setup()
    mount(onSelect)
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Project' }))
    await user.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Destination rejected.')
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onSelect.mock.calls).toEqual([['/projects/Project'], ['/projects/Project']])
  })

})
