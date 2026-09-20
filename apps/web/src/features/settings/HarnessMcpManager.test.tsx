import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { HarnessMcpManager } from './HarnessMcpManager'

const revision = 'sha256:' + 'a'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })

it.each(['codex', 'opencode'] as const)('adds and removes Operator and Linear MCP in %s with one click each', async (harness) => {
  const installed = new Set<string>()
  const calls: Array<{ preset: string; installed: boolean }> = []
  server.use(
    http.get(`/api/management/harnesses/${harness}/mcp`, () => HttpResponse.json({ harness, revision, checkedAt, scope: 'native-user',
      servers: [...installed].map((name) => ({ name, transport: 'remote', label: name === 'linear' ? 'mcp.linear.app' : '127.0.0.1:3000',
        enabled: true, origin: 'user', protected: name === 'graphql-operator', editable: name === 'linear' })),
      presets: { operator: installed.has('graphql-operator') ? 'installed' : 'missing', linear: installed.has('linear') ? 'installed' : 'missing' },
    })),
    http.get(`/api/management/harnesses/${harness}/mcp/plans`, () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { preset: string; installed: boolean }
      calls.push(input)
      const name = input.preset === 'operator' ? 'graphql-operator' : 'linear'
      if (input.installed) installed.add(name); else installed.delete(name)
      return HttpResponse.json({ id: crypto.randomUUID(), harness, revision, change: { kind: input.installed ? 'add' : 'remove', name,
        ...(input.installed ? { connection: { transport: 'remote', url: name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp/operator' } } : {}) },
      managedPreset: input.preset, requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness={harness} /></QueryClientProvider>)
  for (const [, label] of [['operator', 'Operator MCP'], ['linear', 'Linear MCP']] as const) {
    fireEvent.click(await screen.findByRole('button', { name: `Add ${label}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: `Remove ${label}` })).toBeEnabled())
    expect(screen.queryByRole('dialog', { name: 'Review MCP change' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `Remove ${label}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: `Add ${label}` })).toBeEnabled())
  }
  expect(calls.map(({ preset, installed }) => [preset, installed])).toEqual([
    ['operator', true], ['operator', false], ['linear', true], ['linear', false],
  ])
})

it('keeps the original command identity when a one-click response is uncertain', async () => {
  const inputs: Array<{ commandId: string }> = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
      presets: { operator: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { commandId: string }; inputs.push(input)
      return inputs.length === 1 ? HttpResponse.json({ code: 'UNAVAILABLE', message: 'Response lost' }, { status: 503 })
        : HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
          change: { kind: 'add', name: 'graphql-operator', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp/operator' } },
          managedPreset: 'operator', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Add Operator MCP' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original change' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]?.commandId).toBe(inputs[0]?.commandId)
})
