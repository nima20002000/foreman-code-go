import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ProviderAccountAuthentication } from './ProviderAccountAuthentication'
import { authenticationOperation, observedAccount, operationId } from './providerAccounts.fixtures'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount(savedOperationId?: string, canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const [open, setOpen] = useState(true)
    const [selected, setSelected] = useState(savedOperationId)
    return <><button onClick={() => setOpen(true)}>Reopen progress</button>
      <ProviderAccountAuthentication account={observedAccount()} revision={1} canManage={canManage} open={open}
        {...(selected ? { operationId: selected } : {})} onOperation={setSelected} onClose={() => setOpen(false)} /></>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { client, user: userEvent.setup() }
}

it('prepares one operation, hides without canceling, and reopens its original progress', async () => {
  let prepares = 0
  let cancels = 0
  const reads: unknown[] = []
  server.use(
    http.post('/api/provider-accounts/:id/authentication', () => {
      prepares++
      return HttpResponse.json({ value: authenticationOperation(), replayed: false })
    }),
    http.post('/api/provider-accounts/authentication/status', async ({ request }) => {
      reads.push(await request.json())
      return HttpResponse.json(authenticationOperation())
    }),
    http.post('/api/provider-accounts/authentication/cancel', () => { cancels++; return HttpResponse.error() }),
  )
  const { user, client } = mount()
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Hide progress' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Reopen progress' }))
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  await waitFor(() => expect(reads.length).toBeGreaterThan(0))
  expect(reads.at(-1)).toMatchObject({ operationId })
  expect(prepares).toBe(1)
  expect(cancels).toBe(0)
  expect(client.getMutationCache().getAll().map(item => item.state.variables)).toEqual([
    expect.objectContaining({ action: 'prepare', input: expect.objectContaining({ intent: 'sign-in', expectedRevision: 1 }) }),
  ])
})

it('retains the original command after a lost prepare acknowledgement and locks dismissal', async () => {
  const requests: unknown[] = []
  server.use(http.post('/api/provider-accounts/:id/authentication', async ({ request }) => {
    requests.push(await request.json())
    return requests.length === 1 ? HttpResponse.error()
      : HttpResponse.json({ value: authenticationOperation(), replayed: true })
  }), http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation())))
  const { user } = mount()
  await user.click(screen.getByRole('button', { name: 'Prepare authentication' }))
  const retry = await screen.findByRole('button', { name: 'Retry original authentication' })
  expect(screen.getByRole('button', { name: 'Hide progress' })).toBeDisabled()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toBeVisible()
  await user.click(retry)
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  expect(requests[1]).toEqual(requests[0])
})

it('keeps cancellation unconfirmed until the same native operation closes', async () => {
  let operation = authenticationOperation()
  const cancels: unknown[] = []
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(operation)),
    http.post('/api/provider-accounts/authentication/cancel', async ({ request }) => {
      cancels.push(await request.json())
      operation = authenticationOperation({ revision: 2, cancelRequested: true, state: 'outcome-unknown' })
      return HttpResponse.json({ value: operation, replayed: false })
    }))
  const { user } = mount(operationId)
  await user.click(await screen.findByRole('button', { name: 'Cancel authentication' }))
  expect(await screen.findByText('Cancel requested. The provider has not confirmed closure.')).toBeVisible()
  expect(screen.queryByText('Authentication canceled')).not.toBeInTheDocument()
  expect(cancels[0]).toMatchObject({ operationId })
  operation = authenticationOperation({ revision: 3, state: 'canceled', cancelRequested: true, nativeClosed: true,
    humanActionRequired: false })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(await screen.findByText('Authentication canceled')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Cancel authentication' })).not.toBeInTheDocument()
})

it.each(['expired', 'failed', 'outcome-unknown'] as const)('rechecks a saved %s operation without starting another login', async state => {
  let prepares = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation({ state }))),
    http.post('/api/provider-accounts/:id/authentication', () => { prepares++; return HttpResponse.error() }))
  const { user } = mount(operationId)
  await screen.findByRole('button', { name: 'Recheck original operation' })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Prepare authentication' })).not.toBeInTheDocument()
  expect(prepares).toBe(0)
})

it('does not treat late completion after cancel as a default change or a replacement operation', async () => {
  let operation = authenticationOperation({ cancelRequested: true, state: 'outcome-unknown', revision: 2 })
  let prepares = 0
  let defaults = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(operation)),
    http.post('/api/provider-accounts/:id/authentication', () => { prepares++; return HttpResponse.error() }),
    http.post('/api/provider-accounts/:id/default', () => { defaults++; return HttpResponse.error() }))
  const { user } = mount(operationId)
  await screen.findByText('Authentication outcome unknown')
  operation = authenticationOperation({ cancelRequested: true, state: 'completed', revision: 3, nativeClosed: true,
    humanActionRequired: false })
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(await screen.findByText('Authentication completed')).toBeVisible()
  expect(screen.getByText(/Its default is unchanged/)).toBeVisible()
  expect(prepares).toBe(0)
  expect(defaults).toBe(0)
})


it('allows a read-only caller to recheck progress while disabling cancellation', async () => {
  let cancels = 0
  server.use(http.post('/api/provider-accounts/authentication/status', () => HttpResponse.json(authenticationOperation())),
    http.post('/api/provider-accounts/authentication/cancel', () => { cancels++; return HttpResponse.error() }))
  const { user } = mount(operationId, false)
  expect(await screen.findByText('Waiting for human sign-in')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Cancel authentication' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Recheck original operation' }))
  expect(cancels).toBe(0)
})
