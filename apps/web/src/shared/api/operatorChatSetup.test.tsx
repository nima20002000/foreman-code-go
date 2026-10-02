import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { configuredOperatorSetup, unconfiguredOperatorSetup } from '../../features/operator-chat/operatorSetupTestFixture'
import { OperatorSetupNotice } from '../../features/operator-chat/OperatorSetupNotice'
import { useOperatorChatSetup } from './operatorChatSetup'

let client: QueryClient
afterEach(() => { cleanup(); client?.clear() })
function Setup({ revision = 1, harness = 'codex' }: { revision?: number; harness?: 'codex' | 'opencode' }) {
  const query = useOperatorChatSetup(true, revision, { harness })
  return <OperatorSetupNotice data={query.data} checking={query.isFetching} failed={query.isError} onRetry={() => void query.refetch()} />
}

it('reuses verified installation across chat remounts and rechecks when configuration is invalidated', async () => {
  let checks = 0
  let configured = true
  server.use(http.get('/api/operator/setup', () => { checks++; return HttpResponse.json(configured ? configuredOperatorSetup('codex') : unconfiguredOperatorSetup('codex')) }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mount = () => render(<QueryClientProvider client={client}><Setup /></QueryClientProvider>)
  mount()
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['operator-chat', 'setup'] })[0]?.state.status).toBe('success'))
  expect(checks).toBe(1)
  cleanup(); mount()
  expect(screen.queryByText('Checking GraphQL MCP installation…')).not.toBeInTheDocument()
  await waitFor(() => expect(checks).toBe(1))
  configured = false
  await client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] })
  expect(await screen.findByText('Install GraphQL MCP in Codex first')).toBeVisible()
  expect(checks).toBe(2)
})

it('rechecks changed defaults and selected harness instead of inheriting another configuration success', async () => {
  const targets: string[] = []
  server.use(http.get('/api/operator/setup', ({ request }) => {
    const query = new URL(request.url).searchParams
    targets.push(`${query.get('harness')}:${query.get('expectedDefaultsRevision')}`)
    return HttpResponse.json(configuredOperatorSetup(query.get('harness') === 'opencode' ? 'opencode' : 'codex'))
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (revision: number, harness: 'codex' | 'opencode') => <QueryClientProvider client={client}><Setup revision={revision} harness={harness} /></QueryClientProvider>
  const view = render(ui(1, 'codex'))
  await waitFor(() => expect(targets).toEqual(['codex:1']))
  view.rerender(ui(2, 'codex'))
  await waitFor(() => expect(targets).toEqual(['codex:1', 'codex:2']))
  view.rerender(ui(2, 'opencode'))
  await waitFor(() => expect(targets).toEqual(['codex:1', 'codex:2', 'opencode:2']))
})
