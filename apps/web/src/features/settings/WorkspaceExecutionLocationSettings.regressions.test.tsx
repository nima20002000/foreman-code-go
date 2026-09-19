import { useState } from 'react'
import type { ManagedWorkspace } from '@graphql/contracts/management'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { editLocationDraft, useWorkspaceLocationDraftStore } from './workspaceLocationDraftStore'

// Isolate draft/Query race coverage from the folder browser, which has real UI tests.
let selectedWorkspace = 'workspace-a'
vi.mock('./WorkspaceFolderPicker', () => ({
  WorkspaceFolderPicker: ({ value, disabled, onSelect }: { value: string; disabled: boolean; onSelect(path: string): Promise<void> }) => {
    const [pending, setPending] = useState(false)
    const dirty = useWorkspaceLocationDraftStore((state) => state.drafts[selectedWorkspace]?.dirty)
    return <><input aria-label="Execution folder path" value={value} readOnly />
      <button disabled={disabled || !dirty || pending} onClick={async () => {
        setPending(true)
        try { await onSelect(value) } catch { /* The real picker displays this error. */ }
        finally { setPending(false) }
      }}>{pending ? 'Saving…' : 'Save location'}</button></>
  },
}))

const clients: QueryClient[] = []
const checkedAt = '2026-09-15T00:00:00Z'
function workspace(id: string, revision = 1, rootPath = `/projects/${id}`): ManagedWorkspace {
  return {
    workspace: { id, name: `Workspace ${id}` }, revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath }, locationRevision: revision,
    locationValidation: { status: 'ready', checkedAt },
  }
}
function result(id: string, revision: number, rootPath: string) {
  const location = { runnerId: 'runner-local', rootPath }
  return { value: { workspaceId: id, executionLocation: location, locationRevision: revision,
    validation: { workspaceId: id, location, accessMode: 'read-only', checkedAt } }, replayed: false }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
function mount(...saved: ManagedWorkspace[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  for (const value of saved) client.setQueryData(queryKeys.managedWorkspace(value.workspace.id), value)
  const element = (id: string) => <QueryClientProvider client={client}>
    <WorkspaceExecutionLocationSettings workspaceId={id} />
  </QueryClientProvider>
  selectedWorkspace = 'workspace-a'
  const rendered = render(element('workspace-a'))
  return { ...rendered, client, navigate: (id: string) => { selectedWorkspace = id; rendered.rerender(element(id)) } }
}
const pathInput = () => screen.getByRole('textbox', { name: 'Execution folder path' })
const edit = (value: string) => act(() => useWorkspaceLocationDraftStore.getState().update(selectedWorkspace, (draft) => draft ? editLocationDraft(draft, value) : draft))

beforeEach(() => useWorkspaceLocationDraftStore.getState().reset())
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe('PR #5 location form races with real React and Query', () => {
  it.each([1, 7])('keeps workspace drafts separate when the destination revision is %s', async (revision) => {
    const user = userEvent.setup()
    const writes: Record<string, unknown>[] = []
    server.use(http.put('/api/management/workspaces/:workspaceId/location', async ({ request, params }) => {
      const input = await request.json() as Record<string, unknown>
      writes.push({ ...input, workspaceId: params.workspaceId })
      return HttpResponse.json(result(String(params.workspaceId), revision + 1, String(input.rootPath)))
    }))
    const view = mount(workspace('workspace-a'), workspace('workspace-b', revision))
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/a-unsaved')
    view.navigate('workspace-b')
    await waitFor(() => expect(pathInput()).toHaveValue('/projects/workspace-b'))
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled()
    edit('/b-edited')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ workspaceId: 'workspace-b', rootPath: '/b-edited', expectedLocationRevision: revision })
    view.navigate('workspace-a')
    await waitFor(() => expect(pathInput()).toHaveValue('/a-unsaved'))
  })

  it('hides the previous form while an uncached destination loads', async () => {
    const gate = deferred()
    server.use(http.get('/api/management/workspaces/workspace-b', async () => {
      await gate.promise
      return HttpResponse.json(workspace('workspace-b'))
    }))
    const view = mount(workspace('workspace-a'))
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/a-unsaved')
    view.navigate('workspace-b')
    expect(screen.queryByRole('textbox', { name: 'Execution folder path' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save location' })).not.toBeInTheDocument()
    gate.resolve()
    await waitFor(() => expect(pathInput()).toHaveValue('/projects/workspace-b'))
    view.navigate('workspace-a')
    await waitFor(() => expect(pathInput()).toHaveValue('/a-unsaved'))
  })

  it('applies a pending Save only to its submitted workspace and keeps a newer local edit', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    server.use(http.put('/api/management/workspaces/workspace-a/location', async () => {
      await gate.promise
      return HttpResponse.json(result('workspace-a', 2, '/submitted'))
    }))
    const view = mount(workspace('workspace-a'), workspace('workspace-b'))
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/submitted')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    edit('/newer')
    view.navigate('workspace-b')
    await waitFor(() => expect(pathInput()).toHaveValue('/projects/workspace-b'))
    gate.resolve()
    await waitFor(() => expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-a']?.baseRevision).toBe(2))
    expect(pathInput()).toHaveValue('/projects/workspace-b')
    view.navigate('workspace-a')
    await waitFor(() => expect(pathInput()).toHaveValue('/newer'))
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled()
  })

  it.each([false, true])('ignores a delayed old poll after Save 2 (newer edit: %s)', async (newerEdit) => {
    const user = userEvent.setup()
    const old = workspace('workspace-a')
    const gate = deferred()
    server.use(http.put('/api/management/workspaces/workspace-a/location', async () => {
      await gate.promise
      return HttpResponse.json(result('workspace-a', 2, '/submitted'))
    }))
    const view = mount(old)
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/submitted')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    await screen.findByRole('button', { name: 'Saving…' })
    if (newerEdit) edit('/newer')
    gate.resolve()
    await waitFor(() => expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-a']?.baseRevision).toBe(2))
    act(() => view.client.setQueryData(queryKeys.managedWorkspace('workspace-a'), old))
    act(() => view.client.setQueryData(queryKeys.managedWorkspace('workspace-a'), workspace('workspace-a', 2, '/submitted')))
    expect(pathInput()).toHaveValue(newerEdit ? '/newer' : '/submitted')
    if (!newerEdit) edit('/next-edit')
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled()
    act(() => view.client.setQueryData(queryKeys.managedWorkspace('workspace-a'), workspace('workspace-a', 3, '/external')))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled())
    expect(screen.getByText(/saved location changed elsewhere/i)).toBeVisible()
  })

  it('hydrates a clean form from a newer external snapshot already cached before Save finishes', async () => {
    const user = userEvent.setup()
    const gate = deferred()
    server.use(http.put('/api/management/workspaces/workspace-a/location', async () => {
      await gate.promise
      return HttpResponse.json(result('workspace-a', 2, '/submitted'))
    }))
    const view = mount(workspace('workspace-a'))
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/submitted')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    await screen.findByRole('button', { name: 'Saving…' })
    act(() => view.client.setQueryData(queryKeys.managedWorkspace('workspace-a'), workspace('workspace-a', 3, '/external-newer')))
    await waitFor(() => expect(screen.getByText(/saved location changed elsewhere/i)).toBeVisible())
    gate.resolve()
    await waitFor(() => expect(pathInput()).toHaveValue('/external-newer'))
    expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-a']?.baseRevision).toBe(3)
  })

  it.each([false, true])('reloads from the server after a conflict, preserving edits on failure (%s)', async (failReload) => {
    const user = userEvent.setup()
    const writes: Record<string, unknown>[] = []
    let gets = 0
    server.use(
      http.put('/api/management/workspaces/workspace-a/location', async ({ request }) => {
        const input = await request.json() as Record<string, unknown>
        writes.push(input)
        if (input.expectedLocationRevision === 1) return HttpResponse.json({ error: {
          code: 'LOCATION_REVISION_CONFLICT', message: 'The saved location changed.', details: { currentLocationRevision: 2 },
        } }, { status: 409 })
        return HttpResponse.json(result('workspace-a', 3, String(input.rootPath)))
      }),
      http.get('/api/management/workspaces/workspace-a', () => {
        gets++
        return failReload ? HttpResponse.json({ error: { code: 'OFFLINE', message: 'Reload failed.' } }, { status: 503 })
          : HttpResponse.json(workspace('workspace-a', 2, '/external'))
      }),
    )
    mount(workspace('workspace-a'))
    await screen.findByRole('textbox', { name: 'Execution folder path' })
    edit('/local-edit')
    await user.click(screen.getByRole('button', { name: 'Save location' }))
    await user.click(await screen.findByRole('button', { name: 'Reload saved location' }))
    await waitFor(() => expect(gets).toBe(1))
    if (failReload) {
      await screen.findByText(/Your local edit was preserved/)
      expect(pathInput()).toHaveValue('/local-edit')
      expect(useWorkspaceLocationDraftStore.getState().drafts['workspace-a']?.baseRevision).toBe(1)
      expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled()
    } else {
      await waitFor(() => expect(pathInput()).toHaveValue('/external'))
      edit('/after-reload')
      await user.click(screen.getByRole('button', { name: 'Save location' }))
      await waitFor(() => expect(writes).toHaveLength(2))
      expect(writes[1]).toMatchObject({ rootPath: '/after-reload', expectedLocationRevision: 2 })
    }
  })
})
