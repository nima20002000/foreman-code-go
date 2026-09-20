import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'

const revision = 'sha256:' + 'a'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const base = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1.0.0',
  enabled: true, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL' }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); sessionStorage.clear() })
function mount(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

it('keeps Plugins in Codex settings and discovers, installs, and removes with honest contents', async () => {
  let installed = false
  const changes: string[] = []
  server.use(
    http.get('/api/management/harnesses/codex/plugins', ({ request }) => {
      const view = new URL(request.url).searchParams.get('view')
      const items = (view === 'installed') === installed ? [{ ...base, installed }] : []
      return HttpResponse.json({ items, total: items.length, nextOffset: null, revision, checkedAt })
    }),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => HttpResponse.json({ plugin: { ...base, installed },
      contents: installed ? { status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes-mcp'], apps: [] } : { status: 'unknown' } })),
    http.post('/api/management/harnesses/codex/plugins/change', async ({ request }) => {
      const input = await request.json() as { action: string }
      changes.push(input.action)
      installed = input.action === 'install'
      return HttpResponse.json({ pluginId: base.pluginId, action: input.action, status: 'applied', message: installed ? 'Installed in Codex.' : 'Removed from Codex.' })
    }),
  )
  const user = userEvent.setup()
  const router = mount('/settings/harnesses?harness=codex&section=plugins')
  expect(await screen.findByRole('heading', { name: 'Plugins', level: 2 })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Installed' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Discover' }))
  const card = await screen.findByRole('button', { name: 'View notes plugin, available' })
  await user.click(card)
  expect(await screen.findByRole('dialog', { name: 'notes plugin' })).toHaveTextContent('Bundle contents unavailable')
  expect(router.state.location.search.pluginId).toBe(base.pluginId)
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  const installedCard = await screen.findByRole('button', { name: 'View notes plugin, installed' })
  expect(installedCard).toBeVisible()
  expect(screen.getByRole('dialog', { name: 'notes plugin' })).toHaveTextContent('summarize')
  expect(screen.getByRole('dialog', { name: 'notes plugin' })).toHaveTextContent('None included')
  await user.click(screen.getByRole('button', { name: /^Close$/ }))
  await waitFor(() => expect(installedCard).toHaveFocus())
  await user.click(installedCard)
  await user.click(screen.getByRole('button', { name: 'Remove plugin' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'notes plugin' })).not.toBeInTheDocument())
  expect(changes).toEqual(['install', 'remove'])
  expect(router.state.location.search.pluginId).toBeUndefined()
})

it('does not expose the Codex Plugins section in OpenCode settings', async () => {
  const router = mount('/settings/harnesses?harness=opencode&section=plugins')
  expect(await screen.findByRole('heading', { name: 'OpenCode settings' })).toBeVisible()
  await waitFor(() => expect(router.state.location.search.section).toBe('model'))
  expect(screen.queryByRole('button', { name: 'Plugins' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save OpenCode preset' })).toBeInTheDocument()
})

it('keeps an unconfirmed install inspectable and blocks a second change until refresh', async () => {
  let changes = 0
  server.use(
    http.get('/api/management/harnesses/codex/plugins', () => HttpResponse.json({ items: [{ ...base, installed: false }], total: 1,
      nextOffset: null, revision, checkedAt })),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => HttpResponse.json({ plugin: { ...base, installed: false }, contents: { status: 'unknown' } })),
    http.post('/api/management/harnesses/codex/plugins/change', () => { changes++; return HttpResponse.json({ pluginId: base.pluginId, action: 'install', status: 'uncertain', message: 'Inspect native catalog.' }) }),
  )
  const user = userEvent.setup()
  mount('/settings/harnesses?harness=codex&section=plugins&pluginView=available')
  await user.click(await screen.findByRole('button', { name: 'View notes plugin, available' }))
  await user.click(screen.getByRole('button', { name: 'Install plugin' }))
  expect(await screen.findByRole('dialog', { name: 'notes plugin' })).toHaveTextContent('The install or removal may have completed.')
  expect(screen.getByRole('button', { name: 'Install plugin' })).toBeDisabled()
  expect(changes).toBe(1)
  await user.click(screen.getByRole('button', { name: 'Refresh list' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Install plugin' })).toBeEnabled())
})
