import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { WorkerExecutionSettings } from './WorkerExecutionSettings'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><WorkerExecutionSettings /></QueryClientProvider>)
}

it('shows the default-off deployment status without offering an application write', async () => {
  server.use(http.get('/api/management/settings/worker-execution', () =>
    HttpResponse.json({ enabled: false, managedBy: 'startup' })))
  mount()
  expect(await screen.findByText('Off')).toBeVisible()
  expect(screen.getByText(/all connected Worker computers/)).toBeVisible()
  expect(screen.getByText(/Main execution stays available/)).toBeVisible()
  expect(screen.getByText(/cannot be changed here or through MCP/)).toBeVisible()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /enable|save/i })).not.toBeInTheDocument()
})

it('shows the enabled state returned by Main', async () => {
  server.use(http.get('/api/management/settings/worker-execution', () =>
    HttpResponse.json({ enabled: true, managedBy: 'startup' })))
  mount()
  expect(await screen.findByText('On')).toBeVisible()
})

it('shows a readable failure and supported retry action', async () => {
  server.use(http.get('/api/management/settings/worker-execution', () =>
    HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, { status: 403 })))
  mount()
  expect(await screen.findByText('The execution setting could not be read.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Retry execution setting' })).toBeEnabled()
})
