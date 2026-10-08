import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { OperatorMcpStatus } from './OperatorMcpStatus'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

const revision = 'sha256:' + 'a'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

it('installs the Operator MCP on Codex in one click and shows the read-back state', async () => {
  let installed = false
  const inputs: unknown[] = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
      presets: { graphql: installed ? 'installed' : 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      inputs.push(await request.json()); installed = true
      return HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
        change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
        managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  mount(<OperatorMcpStatus harness="codex" defaults={DEFAULT_HARNESS_DEFAULTS} revision={3} />)
  expect(await screen.findByText('Not installed')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  expect(await screen.findByText('Installed')).toBeVisible()
  expect(inputs).toMatchObject([{ harness: 'codex', preset: 'graphql', installed: true, expectedRevision: revision }])
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
})

it('adds this app MCP endpoint to the saved Claude preset in one click', async () => {
  const saved: Array<{ defaults: { claude?: { mcpServers: Record<string, unknown> } }; expectedRevision: number }> = []
  const endpoint = { type: 'http', url: 'http://127.0.0.1:3000/mcp' }
  const claude = { ...savedClaudeConfiguration, mcpServers: {} }
  server.use(
    http.get('/api/management/harnesses/claude/setup-options', () => HttpResponse.json({ graphqlMcp: endpoint })),
    http.put('/api/management/harnesses/defaults', async ({ request }) => {
      const body = await request.json() as typeof saved[number]; saved.push(body)
      return HttpResponse.json({ value: { defaults: body.defaults, revision: 4 }, replayed: false })
    }),
  )
  mount(<OperatorMcpStatus harness="claude" defaults={{ ...DEFAULT_HARNESS_DEFAULTS, claude }} revision={3} />)
  const install = await screen.findByRole('button', { name: 'Install' })
  await waitFor(() => expect(install).toBeEnabled())
  fireEvent.click(install)
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]!.expectedRevision).toBe(3)
  expect(Object.values(saved[0]!.defaults.claude!.mcpServers)).toEqual([endpoint])
})

it('reports Claude as installed when its preset already has the app MCP', () => {
  mount(<OperatorMcpStatus harness="claude" revision={3}
    defaults={{ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...savedClaudeConfiguration, mcpServers: { 'foreman-code': { type: 'http', url: 'http://127.0.0.1:3000/mcp' } } } }} />)
  expect(screen.getByText('Installed')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
})
