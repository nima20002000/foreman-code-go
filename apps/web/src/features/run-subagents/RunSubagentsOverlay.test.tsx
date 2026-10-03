import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { runA, runsUrl } from '../run-board/testFixtures'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { RunSubagentsOverlay } from './RunSubagentsOverlay'
import { subagentsKey } from './query'
import { base, child, detail, message, scope, tool } from './testFixtures'
import { layoutSubagents } from './layout'

const clients: QueryClient[] = []
afterEach(() => { clients.forEach((client) => client.clear()); clients.length = 0 })
beforeEach(() => {
  installFlowLayout()
  server.use(
    http.get(base, () => HttpResponse.json({ items: [detail(), detail(child({ id: 'nested', name: 'Nested', parentSubagentId: 'child-1' }))], nextCursor: null, projection: 'caught-up' })),
    http.get(`${base}/:subagentId`, () => HttpResponse.json(detail())),
    http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [message()], nextCursor: null, coverage: child().coverage })),
    http.get(`${base}/:subagentId/tools`, () => HttpResponse.json({ items: [tool()], nextCursor: null, coverage: child().coverage })),
  )
})
async function mount(entry = runsUrl('run-a')) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  function Canvas() {
    return <div style={{ width: 800, height: 600 }}><ReactFlowProvider><ReactFlow nodes={[]} edges={[]}>
      <RunSubagentsOverlay snapshot={runA} />
    </ReactFlow></ReactFlowProvider></div>
  }
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema, component: Canvas })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('button', { name: 'Research, codex, running' })
  return { client, router }
}
describe('Run subagent overlays', () => {
  it('attaches circles to saved parents and nested children to their immediate child', async () => {
    await mount()
    const root = screen.getByRole('button', { name: 'Research, codex, running' })
    const nested = screen.getByRole('button', { name: 'Nested, codex, running' })
    expect(root).toHaveAttribute('data-parent-id', 'node-x')
    expect(nested).toHaveAttribute('data-parent-id', 'child-1')
    expect(root).toHaveStyle({ left: '156px', top: '100px' })
    expect(nested).toHaveStyle({ left: '216px', top: '152px' })
    expect(document.querySelectorAll('.run-subagents-links line')).toHaveLength(2)
    expect(runA.nodes[0]?.position).toEqual({ x: -80, y: 40 })
  })
  it('keeps finished circles attached and reports terminal status', async () => {
    const { client } = await mount()
    server.use(http.get(base, () => HttpResponse.json({ items: [detail(child({ status: 'completed', finishedAt: '2026-10-03T01:01:00.000Z' }))], nextCursor: null, projection: 'caught-up' })))
    await act(async () => { await client.invalidateQueries({ queryKey: subagentsKey(scope) }) })
    const completed = await screen.findByRole('button', { name: 'Research, codex, completed' })
    expect(completed).toHaveAttribute('data-inactive', 'true')
    expect(completed).toHaveAttribute('data-parent-id', 'node-x')
  })
  it('opens messages, tools, clipping and lifecycle with unsupported steering hidden', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Research, codex, running' }))
    await screen.findByText('Child answer')
    expect(screen.getByText('read_file · completed')).toBeVisible()
    expect(screen.getByText('Message clipped from 25000 bytes.')).toBeVisible()
    expect(screen.getByText('Tool evidence clipped from 35000 bytes.')).toBeVisible()
    expect(screen.getByText('Transcript coverage: partial.')).toBeVisible()
    expect(screen.getByText('Input not supported by Codex.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Send input' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt subagent' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Lifecycle' })).toHaveTextContent('running')
    fireEvent.click(screen.getByText('Result'))
    expect(screen.getByText('"Read result"')).toBeVisible()
  })
  it('owns selection in the URL, supports a fresh deep link, and clears it on close', async () => {
    const { router } = await mount(`${runsUrl('run-a')}#selectedSubagentId=child-1`)
    await screen.findByText('Child answer')
    expect(router.history.location.hash).toContain('selectedSubagentId=child-1')
    fireEvent.click(screen.getByRole('button', { name: 'Close subagent' }))
    await waitFor(() => expect(router.history.location.hash).not.toContain('selectedSubagentId'))
    fireEvent.click(screen.getByRole('button', { name: 'Research, codex, running' }))
    await waitFor(() => expect(router.history.location.hash).toContain('selectedSubagentId=child-1'))
    expect(router.history.location.search).toContain('selectedRunId=run-a')
  })
  it('pages the roster and explains projection lag and missing parent evidence', async () => {
    server.use(http.get(base, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('cursor')
      ? { items: [detail(child({ id: 'nested', name: 'Nested', parentSubagentId: 'child-1' }))], nextCursor: null, projection: 'caught-up' }
      : { items: [detail(), detail(child({ id: 'orphan', parentSubagentId: 'missing' }))], nextCursor: 'page-2', projection: 'catching-up' })))
    await mount()
    expect(screen.getByText('Subagent evidence catching up.')).toBeVisible()
    expect(screen.getByText('Some attachments await parent evidence.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Load more subagents' }))
    await screen.findByRole('button', { name: 'Nested, codex, running' })
  })
  it('removes cached circles after a denied refresh', async () => {
    const { client } = await mount()
    server.use(http.get(base, () => HttpResponse.json({ error: { code: 'DENIED', message: 'Denied' } }, { status: 403 })))
    await act(async () => { await client.invalidateQueries({ queryKey: subagentsKey(scope) }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Research, codex, running' })).not.toBeInTheDocument())
    expect(screen.getByText('Subagents unavailable.')).toBeVisible()
  })
  it('does not attach orphans or cyclic evidence to a guessed parent', () => {
    expect(layoutSubagents(runA.nodes, [child({ parentSubagentId: 'missing' }), child({ id: 'cycle', parentSubagentId: 'cycle' })])).toEqual([])
  })
})
