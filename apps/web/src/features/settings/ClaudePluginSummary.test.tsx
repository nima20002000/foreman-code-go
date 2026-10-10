import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  useOperatorChatStore.getState().reset()
})
function mount() {
  const router = createRouter({ routeTree, history: createMemoryHistory({
    initialEntries: ['/settings/harnesses?harness=claude&section=plugins'],
  }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}
it('reads the real client boundary, keeps discovery in the URL, and drafts changes for the Operator', async () => {
  server.use(http.get('/api/management/harnesses/claude/plugins', ({ request }) => {
    const installed = new URL(request.url).searchParams.get('view') !== 'available'
    return HttpResponse.json({
      items: [{ pluginId: 'notes@official', name: 'notes', marketplaceName: 'official', description: 'Notes tools',
        version: '1.0.0', installed, enabled: installed, installCount: 10 }],
      total: 1, nextOffset: null, marketplaces: [], revision: 'a'.repeat(64), checkedAt: new Date().toISOString(),
    })
  }))
  const router = mount()
  const user = userEvent.setup()
  // App connection and harness defaults load before the plugin catalog can mount.
  expect(await screen.findByText('1 installed plugins', {}, { timeout: 10_000 })).toBeVisible()
  expect(await screen.findByRole('button', { name: 'Ask Operator to manage notes' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Discover' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ pluginView: 'available' }))
  await user.click(await screen.findByRole('button', { name: 'Ask Operator to install notes' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Claude plugins' })).not.toBeInTheDocument())
  expect(await screen.findByPlaceholderText('Message the operator…')).toHaveValue('Install the Claude Code plugin notes@official. ')
}, 20_000)
it('shows access failures without plugin data or edit controls for a plugin', async () => {
  server.use(http.get('/api/management/harnesses/claude/plugins', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'Plugin access denied.' },
  }, { status: 403 })))
  mount()
  expect(await screen.findByText('Plugin access denied.')).toBeVisible()
  expect(screen.queryByRole('button', { name: /Ask Operator to manage/ })).not.toBeInTheDocument()
})
