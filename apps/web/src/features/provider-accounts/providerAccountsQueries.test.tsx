import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { useProviderAccount, useProviderAccounts, useProviderAccountModels } from './providerAccountsQueries'
import { accountBinding, accountId, observedAccount, secondAccountId } from './providerAccounts.fixtures'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('keeps a late account A read away from the newly selected account B', async () => {
  const late = held<void>()
  let firstStarted = false
  server.use(http.get('/api/provider-accounts/:id', async ({ params }) => {
    if (params.id === accountId) { firstStarted = true; await late.promise }
    return HttpResponse.json(observedAccount(String(params.id)))
  }))
  const view = renderHook(({ id }) => useProviderAccount(accountBinding(id)), {
    initialProps: { id: accountId }, wrapper: wrapper(),
  })
  await waitFor(() => expect(firstStarted).toBe(true))
  view.rerender({ id: secondAccountId })
  await waitFor(() => expect(view.result.current.data?.id).toBe(secondAccountId))
  await act(async () => { late.resolve(); await late.promise })
  expect(view.result.current.data?.name).toBe('Other account')
})

it('orders observations even when the account metadata revision stays the same', async () => {
  const account = observedAccount()
  let sequence = 2
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...account,
    observation: { ...account.observation!, sequence, identity: `observation-${sequence}` } })))
  const view = renderHook(() => useProviderAccount(accountBinding()), { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.data?.observation?.sequence).toBe(2))
  sequence = 1
  await act(async () => { await view.result.current.refetch() })
  expect(view.result.current.data?.observation?.identity).toBe('observation-2')
  sequence = 3
  await act(async () => { await view.result.current.refetch() })
  expect(view.result.current.data?.observation?.identity).toBe('observation-3')
})

it('rejects readback from a different computer or immutable profile', async () => {
  const account = observedAccount()
  server.use(http.get('/api/provider-accounts/:id', () => HttpResponse.json({ ...account,
    binding: { ...account.binding!, profileRef: 'different-profile' } })))
  const view = renderHook(() => useProviderAccount(accountBinding()), { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.isError).toBe(true))
  expect(view.result.current.data).toBeUndefined()
  expect(view.result.current.error?.message).toBe('The saved account binding is unavailable.')
})

it('keeps separate model catalogs and preserves an empty result for account B', async () => {
  server.use(http.get('/api/provider-accounts/:id/models', ({ params }) => HttpResponse.json({
    binding: accountBinding(String(params.id)), generation: 1, observedAt: '2026-10-01T12:00:00.000Z',
    models: params.id === accountId ? [{ id: 'model-a', name: 'Account A model' }] : [],
  })))
  const view = renderHook(({ id }) => useProviderAccountModels(accountBinding(id)), {
    initialProps: { id: accountId }, wrapper: wrapper(),
  })
  await waitFor(() => expect(view.result.current.data?.models).toHaveLength(1))
  view.rerender({ id: secondAccountId })
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true))
  expect(view.result.current.data?.models).toEqual([])
})

it('isolates provider-card failures and retains successful persisted readback', async () => {
  server.use(http.get('/api/provider-accounts/page', ({ request }) => {
    const provider = new URL(request.url).searchParams.get('provider')
    if (provider === 'claude') return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Claude unavailable' } }, { status: 503 })
    return HttpResponse.json({ revision: 1, accounts: [observedAccount()], defaults: [], nextCursor: null })
  }))
  const view = renderHook(() => ({ codex: useProviderAccounts(true, { provider: 'codex' }),
    claude: useProviderAccounts(true, { provider: 'claude' }) }), { wrapper: wrapper() })
  await waitFor(() => expect(view.result.current.claude.isError).toBe(true))
  expect(view.result.current.codex.data?.accounts[0]?.id).toBe(accountId)
})

it('ignores a reply begun under an old browser session', async () => {
  const late = held<void>()
  const next = held<void>()
  let reads = 0
  server.use(http.get('/api/provider-accounts/:id', async () => {
    const read = ++reads
    await (read === 1 ? late.promise : next.promise)
    return HttpResponse.json({ ...observedAccount(), name: read === 1 ? 'Old session account' : 'Current session account' })
  }))
  const view = renderHook(() => useProviderAccount(accountBinding()), { wrapper: wrapper() })
  await waitFor(() => expect(reads).toBe(1))
  await act(async () => { beginSessionChange(); finishSessionChange() })
  await waitFor(() => expect(reads).toBe(2))
  await act(async () => { late.resolve(); await late.promise })
  expect(view.result.current.data).toBeUndefined()
  await act(async () => { next.resolve(); await next.promise })
  await waitFor(() => expect(view.result.current.data?.name).toBe('Current session account'))
})
