import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { BrowserAuthSearchSchema } from '@graphql/contracts/management'
import { server } from '../../mocks/server'
import { browserAuthClient } from '../../shared/api/browserAuth'
import { apiClient } from '../../shared/api/client'
import { finishSessionChange } from '../../shared/api/sessionBoundary'
import { ToastProvider } from '../../shared/ui/nocturne'
import { RequireBrowserSession } from './RequireBrowserSession'
import { SignInRoute, OwnerSetupRoute } from './AuthRoutes'
import userEvent from '@testing-library/user-event'

// These tests exercise auth HTTP, routing and rendering, not the confirmation dialog implementation.
vi.mock('./SignOutButton', () => ({ SignOutButton: () => <button type="button">Sign out</button> }))
vi.mock('./sessionTransition', () => ({ prepareBrowserIdentityChange: vi.fn(async () => undefined), clearBrowserIdentity: vi.fn() }))
const clients: QueryClient[] = []
const session = { principal: { id: 'principal-owner', name: 'Owner', expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read'], scope: {} }] } }
function failure(status: number) { return HttpResponse.json({ error: { code: `AUTH_${status}`, message: status === 401 ? 'The email or password is incorrect.' : 'Request failed.' } }, { status }) }
function mount(path = '/workspaces') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const routes = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/workspaces', component: () => <RequireBrowserSession><div>Private workspace content</div></RequireBrowserSession> }),
    createRoute({ getParentRoute: () => root, path: '/sign-in', validateSearch: BrowserAuthSearchSchema, component: SignInRoute }),
    createRoute({ getParentRoute: () => root, path: '/setup', validateSearch: BrowserAuthSearchSchema, component: OwnerSetupRoute }),
  ])
  const router = createRouter({ routeTree: routes, history: createMemoryHistory({ initialEntries: [path] }) })
  render(<QueryClientProvider client={client}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>)
  return router
}
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); finishSessionChange() })

describe('owner browser authentication', () => {
  it('uses the API boundary for setup, sign-in and sign-out with same-origin cookies', async () => {
    const observed: Array<{ credentials: string; body: unknown }> = []
    server.use(
      http.get('*/api/auth/setup', () => HttpResponse.json({ state: 'ready' })),
      http.post('*/api/auth/setup', async ({ request }) => {
        observed.push({ credentials: request.credentials, body: await request.json() })
        return HttpResponse.json({ created: true }, { status: 201 })
      }),
      http.post('*/api/auth/sign-in/email', async ({ request }) => {
        observed.push({ credentials: request.credentials, body: await request.json() })
        return HttpResponse.json({ signedIn: true })
      }),
      http.post('*/api/auth/logout', () => HttpResponse.json({ signedOut: true })),
    )
    const input = { email: 'owner@example.test', password: 'long-owner-password' }
    expect(await browserAuthClient.setupStatus()).toEqual({ state: 'ready' })
    expect(await browserAuthClient.setup(input)).toEqual({ created: true })
    expect(await browserAuthClient.signIn({ email: input.email, password: input.password })).toEqual({ signedIn: true })
    expect(await browserAuthClient.signOut()).toEqual({ signedOut: true })
    expect(observed).toEqual([
      { credentials: 'same-origin', body: input },
      { credentials: 'same-origin', body: { email: input.email, password: input.password } },
    ])
  })
  it('redirects a missing session to sign-in without rendering protected content', async () => {
    server.use(http.get('*/api/auth/session', () => failure(401)), http.get('*/api/auth/setup', () => HttpResponse.json({ state: 'complete' })))
    const router = mount()
    expect(screen.queryByText('Private workspace content')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/sign-in')
  })
  it.each([403, 503])('keeps %s separate from a sign-in redirect', async (status) => {
    server.use(http.get('*/api/auth/session', () => failure(status)))
    const router = mount()
    expect(await screen.findByRole('heading', { name: status === 403 ? 'Access denied' : 'Cannot reach the server' })).toBeVisible()
    expect(screen.queryByText('Private workspace content')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/workspaces')
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(status === 503)
  })
  it('restores a valid session and redirects after a later protected request returns 401', async () => {
    server.use(http.get('*/api/auth/session', () => HttpResponse.json(session)),
      http.get('*/api/auth/setup', () => HttpResponse.json({ state: 'complete' })),
      http.get('*/api/management/settings/workspaces', () => failure(401)))
    const router = mount()
    expect(await screen.findByText('Private workspace content')).toBeVisible()
    // The schema is immaterial on this error response; the client emits after its generation check.
    await expect(apiClient.request('/api/management/settings/workspaces', BrowserAuthSearchSchema)).rejects.toMatchObject({ status: 401 })
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'))
    expect(screen.queryByText('Private workspace content')).not.toBeInTheDocument()
  })
  it('shows email and password setup only when enabled', async () => {
    server.use(http.get('*/api/auth/setup', () => HttpResponse.json({ state: 'ready' })))
    mount('/setup')
    expect(await screen.findByLabelText(/^Email/)).toBeVisible()
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.queryByLabelText(/name|secret|role|grant|principal/i)).not.toBeInTheDocument()
  })
  it('shows rejected sign-in as an auth error and clears the password field', async () => {
    server.use(http.get('*/api/auth/setup', () => HttpResponse.json({ state: 'complete' })),
      http.post('*/api/auth/sign-in/email', () => failure(401)))
    mount('/sign-in')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/^Email/), 'owner@example.test')
    await user.type(screen.getByLabelText(/^Password/), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is incorrect.')
    expect(screen.getByText('Sign-in failed')).toBeVisible()
    expect(screen.getByLabelText(/^Password/)).toHaveValue('')
  })
})
