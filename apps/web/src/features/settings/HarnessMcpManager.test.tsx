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

it.each(['codex', 'opencode'] as const)('adds, toggles, and removes GraphQL and Linear MCP in %s', async (harness) => {
  const installed = new Map<string, boolean>()
  const calls: Array<{ preset: string; installed?: boolean; enabled?: boolean }> = []
  server.use(
    http.get(`/api/management/harnesses/${harness}/mcp`, () => HttpResponse.json({ harness, revision, checkedAt, scope: 'native-user',
      servers: [...installed].map(([name, enabled]) => ({ name, transport: 'remote', label: name === 'linear' ? 'mcp.linear.app' : '127.0.0.1:3000',
        endpoint: name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp',
        enabled, origin: 'user', protected: name !== 'linear', editable: name === 'linear' })),
      presets: { graphql: installed.has('graphql') ? installed.get('graphql') ? 'installed' : 'disabled' : 'missing',
        linear: installed.has('linear') ? installed.get('linear') ? 'installed' : 'disabled' : 'missing' },
    })),
    http.get(`/api/management/harnesses/${harness}/mcp/plans`, () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { preset: string; installed?: boolean; enabled?: boolean }
      calls.push(input)
      const name = input.preset === 'graphql' ? 'graphql' : 'linear'
      if (input.enabled !== undefined) installed.set(name, input.enabled)
      else if (input.installed) installed.set(name, true); else installed.delete(name)
      return HttpResponse.json({ id: crypto.randomUUID(), harness, revision, change: { kind: input.enabled !== undefined ? 'enable' : input.installed ? 'add' : 'remove', name,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : input.installed ? { connection: { transport: 'remote', url: name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp' } } : {}) },
      managedPreset: input.preset, requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness={harness} /></QueryClientProvider>)
  for (const [name, label] of [['graphql', 'GraphQL MCP'], ['linear', 'Linear MCP']] as const) {
    fireEvent.click(await screen.findByRole('button', { name: `Add ${label}` }))
    const card = await screen.findByRole('button', { name: `View details for ${name}, Enabled` })
    card.focus()
    fireEvent.click(card)
    const dialog = screen.getByRole('dialog', { name: `${name} MCP details` })
    expect(dialog).toBeVisible()
    expect(screen.getByText(name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp')).toBeVisible()
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(dialog).not.toBeVisible()
    expect(card).toHaveFocus()
    fireEvent.click(card)
    expect(screen.queryByRole('dialog', { name: 'Review MCP change' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    fireEvent.click(await screen.findByRole('button', { name: `View details for ${name}, Disabled` }))
    expect(screen.getByRole('dialog', { name: `${name} MCP details` })).toHaveTextContent('Disabled')
    expect(screen.getByRole('button', { name: 'Remove server' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await screen.findByRole('button', { name: `View details for ${name}, Enabled` })
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }))
    await waitFor(() => expect(screen.getByRole('button', { name: `Add ${label}` })).toBeEnabled())
  }
  expect(calls.map(({ preset, installed, enabled }) => [preset, installed, enabled])).toEqual([
    ['graphql', true, undefined], ['graphql', undefined, false], ['graphql', undefined, true], ['graphql', false, undefined],
    ['linear', true, undefined], ['linear', undefined, false], ['linear', undefined, true], ['linear', false, undefined],
  ])
})

it('keeps the original command identity when a one-click response is uncertain', async () => {
  const inputs: Array<{ commandId: string }> = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
      presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { commandId: string }; inputs.push(input)
      return inputs.length === 1 ? HttpResponse.json({ code: 'UNAVAILABLE', message: 'Response lost' }, { status: 503 })
        : HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
          change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
          managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Add GraphQL MCP' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original change' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]?.commandId).toBe(inputs[0]?.commandId)
})

it('keeps protected and inherited servers inspectable while explaining why removal is unavailable', async () => {
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: [
        { name: 'graphql', transport: 'remote', label: '127.0.0.1:3000', endpoint: 'http://127.0.0.1:3000/mcp', enabled: true, origin: 'user', protected: true, editable: false },
        { name: 'shared-tools', transport: 'stdio', label: 'tools', enabled: true, origin: 'inherited', protected: false, editable: false },
      ] })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  const card = await screen.findByRole('button', { name: 'View details for graphql, Enabled' })
  card.focus()
  fireEvent.click(card)
  expect(screen.getByRole('dialog', { name: 'graphql MCP details' })).toHaveTextContent('http://127.0.0.1:3000/mcp')
  fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
  expect(card).toHaveFocus()
  for (const name of ['graphql', 'shared-tools']) {
    fireEvent.click(screen.getByRole('button', { name: `View details for ${name}, ${name === 'graphql' ? 'Enabled' : 'Inherited'}` }))
    expect(screen.getByRole('button', { name: 'Remove server' })).toBeDisabled()
    expect(screen.getByRole('dialog', { name: `${name} MCP details` })).toHaveTextContent(name === 'graphql' ? 'This app-managed connection is protected here.' : 'This connection comes from another configuration source.')
    expect(screen.queryByRole('button', { name: /^(Enable|Disable)$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
  }
})

it('upgrades retired graphql-app and graphql-operator entries to the one GraphQL MCP', async () => {
  const inputs: Array<{ preset: string; installed?: boolean }> = []
  server.use(
    http.get('/api/management/harnesses/opencode/mcp', () => HttpResponse.json({ harness: 'opencode', revision, checkedAt, scope: 'native-user',
      servers: ['graphql-app', 'graphql-operator'].map((name) => ({ name, transport: 'stdio', label: 'Legacy app connection · replaced by graphql',
        enabled: true, origin: 'user', protected: true, editable: false })),
      presets: { graphql: 'legacy', linear: 'missing' } })),
    http.get('/api/management/harnesses/opencode/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { preset: string; installed?: boolean }; inputs.push(input)
      return HttpResponse.json({ id: crypto.randomUUID(), harness: 'opencode', revision,
        change: { kind: 'add', name: 'graphql', connection: { transport: 'stdio', executable: '/usr/bin/node', arguments: ['/launcher.mjs'], environmentVariables: [] } },
        managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="opencode" /></QueryClientProvider>)
  expect(await screen.findByText('Replaces the separate graphql-app and graphql-operator connections with one connection for every role.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'View details for graphql-operator, Needs attention' }))
  expect(screen.getByRole('dialog', { name: 'graphql-operator MCP details' })).toHaveTextContent('This retired connection is replaced by graphql')
  fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Upgrade to GraphQL MCP' }))
  await waitFor(() => expect(inputs).toEqual([expect.objectContaining({ preset: 'graphql', installed: true })]))
})

it('keeps native enablement behind the existing review flow in the details dialog', async () => {
  let planned: { change: { kind: string; enabled: boolean } } | undefined
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: [{ name: 'mytools', transport: 'stdio', label: 'mytools', enabled: true, origin: 'user', protected: false, editable: true }],
      presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/plans', async ({ request }) => {
      planned = await request.json() as typeof planned
      return HttpResponse.json({ value: { id: crypto.randomUUID(), harness: 'codex', revision, change: planned?.change,
        requestedBy: 'owner', status: 'pending', createdAt: checkedAt, expiresAt: '2099-01-01T00:00:00.000Z', error: null }, replayed: false })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'View details for mytools, Enabled' }))
  expect(screen.getByRole('button', { name: 'Remove server' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
  expect(await screen.findByRole('dialog', { name: 'Review MCP change' })).toBeVisible()
  expect(planned?.change).toMatchObject({ kind: 'enable', enabled: false })
})
