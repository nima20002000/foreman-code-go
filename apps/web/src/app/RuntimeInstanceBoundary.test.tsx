import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { bindProtectedChatInstance } from '../shared/api/protectedChatStorage'
import { RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'

vi.mock('../shared/api/protectedChatStorage', async (original) => ({
  ...await original<typeof import('../shared/api/protectedChatStorage')>(), bindProtectedChatInstance: vi.fn(() => false),
}))
const identity = { installationId: 'd95abeb8-598a-49a4-8c3c-c6e3533053e8', checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
const clients: QueryClient[] = []
beforeEach(() => {
  vi.mocked(bindProtectedChatInstance).mockReset().mockReturnValue(false)
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json(identity)))
})
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RuntimeInstanceBoundary><p>Protected content</p></RuntimeInstanceBoundary></QueryClientProvider>)
  return client
}
it('withholds protected content until the local installation is bound', async () => {
  mount()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  expect(await screen.findByText('Protected content')).toBeVisible()
  expect(bindProtectedChatInstance).toHaveBeenCalledWith(`${identity.checkoutId}:${identity.installationId}`)
})
it('hides previously rendered content when identity verification subsequently fails', async () => {
  const client = mount()
  await screen.findByText('Protected content')
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })))
  await client.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] })
  expect(await screen.findByRole('heading', { name: 'Could not verify this app' })).toBeVisible()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
})
it('keeps content hidden on storage failure and allows a real retry', async () => {
  vi.mocked(bindProtectedChatInstance).mockImplementation(() => { throw new Error('storage blocked') })
  mount()
  expect(await screen.findByText('Browser storage is unavailable. Allow storage for this app, then try again.')).toBeVisible()
  expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  vi.mocked(bindProtectedChatInstance).mockReturnValue(false)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByText('Protected content')).toBeVisible())
})
