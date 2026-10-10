import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { DEFAULT_REMOTE_EXECUTION_SETTINGS } from '@foreman-code/contracts/management'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { RemoteExecutionSummary } from './RemoteExecutionSummary'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RemoteExecutionSummary /></QueryClientProvider>)
}

it('shows a compact listener URL, execution state, overrides and Operator guidance', async () => {
  const endpoint = 'wss://main.example:8443/device/connect'
  server.use(http.get('/api/management/settings/remote-execution', () => HttpResponse.json({
    value: DEFAULT_REMOTE_EXECUTION_SETTINGS, revision: 1, versionId: 'saved-settings',
    effective: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS, enabled: true },
    environmentOverrides: ['FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED'],
    runtime: { listenerEnabled: true, listenerEndpoint: endpoint, restartRequired: true, reason: 'computers-connected' },
  })))
  mount()
  const summary = await screen.findByText(/Listener: wss:\/\/main.example:8443\/device\/connect/)
  expect(summary).toHaveTextContent('(on) · Remote execution: on')
  expect(summary).toHaveTextContent('environment overrides')
  expect(summary).toHaveTextContent('restart Main to apply listener changes')
  expect(summary).toHaveTextContent('change via Operator')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('shows disabled status from the server', async () => {
  mount()
  expect(await screen.findByText(/Listener: URL unconfigured \(off\) · Remote execution: off/))
    .toHaveTextContent('change via Operator')
})

it('reports an unavailable status without guessing enablement', async () => {
  server.use(http.get('/api/management/settings/remote-execution', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'Denied.' },
  }, { status: 403 })))
  mount()
  expect(await screen.findByText('Remote execution status unavailable · change via Operator')).toBeVisible()
})
