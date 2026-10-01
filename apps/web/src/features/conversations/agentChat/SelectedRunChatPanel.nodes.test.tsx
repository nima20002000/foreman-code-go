import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RunBoardSnapshotGetResultSchema } from '@graphql/contracts/run-snapshots'
import { server } from '../../../mocks/server'
import { RunsSelectorSearchSchema } from '../../runs-selector/search'
import { useSelectedRun } from '../../runs-selector/useSelectedRun'
import { useConversationDraftStore } from '../conversationDraftStore'
import { SelectedRunChatPanel } from './SelectedRunChatPanel'
import { installChatSource } from './testSupport'
import { clients, installSelectedHandlers, nodeId, scope, snapshot, snapshotRoute } from './sch10.testSupport'

beforeEach(() => { installChatSource() })
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
})

function mixedSnapshot(agentKind?: 'agent', jobsOnly = false) {
  const base = snapshot('run-a')
  if (base.snapshot.kind !== 'available') throw new Error('Expected an available snapshot')
  const job = { kind: 'job', id: 'node-job', name: 'Build Job', jobDefinitionId: 'job-build',
    jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version-pinned',
    position: { x: 0, y: 0 }, size: { width: 240, height: 100 } }
  return RunBoardSnapshotGetResultSchema.parse({ snapshot: { ...base.snapshot,
    nodes: [job, ...(jobsOnly ? [] : base.snapshot.nodes.map((node) => ({ ...node, ...(agentKind ? { kind: agentKind } : {}) })))],
  } })
}

async function mountPanel(selectedNodeId?: string) {
  function Probe() {
    const selection = useSelectedRun(scope)
    const search = route.useSearch()
    return <SelectedRunChatPanel selection={selection} workflowNodeId={search.runNodeId} />
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: Probe })
  const entry = `/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}&selectedRunId=run-a&runId=run-a&workflowVersionId=version-run-a&executionSemanticsVersion=3${selectedNodeId ? `&runNodeId=${selectedNodeId}` : ''}#chat`
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('combobox', { name: 'Agent' })
  return router
}

describe('Selected Run chat Agent nodes (real Router/Query/client + mixed contract snapshot)', () => {
  it.each([undefined, 'agent'] as const)('excludes Jobs and resolves the Agent with kind %s even when the Job is first', async (kind) => {
    const source = installSelectedHandlers()
    server.use(http.get(snapshotRoute, () => HttpResponse.json(mixedSnapshot(kind))))
    await mountPanel()
    await screen.findByText('Reply execution-run-a')
    const picker = screen.getByRole('combobox', { name: 'Agent' })
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Removed Coder'])
    expect(picker).toHaveValue(nodeId)
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.every((url) => new URL(url).pathname.endsWith(`/nodes/${nodeId}`))).toBe(true)
    expect(source.current.calls).toHaveLength(0)
  })

  it('keeps the explicitly URL-selected Agent and its immutable Run pins', async () => {
    const source = installSelectedHandlers()
    server.use(http.get(snapshotRoute, () => HttpResponse.json(mixedSnapshot('agent'))))
    const router = await mountPanel(nodeId), href = router.history.location.href
    await screen.findByText('Reply execution-run-a')
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue(nodeId)
    expect(source.reads.every((url) => new URL(url).pathname.endsWith(`/nodes/${nodeId}`))).toBe(true)
    expect(router.history.location.href).toBe(href)
  })

  it.each(['node-job', 'node-missing'])('keeps URL selection %s unavailable until an Agent is explicitly chosen', async (selectedNodeId) => {
    const source = installSelectedHandlers()
    server.use(http.get(snapshotRoute, () => HttpResponse.json(mixedSnapshot('agent'))))
    const router = await mountPanel(selectedNodeId), href = router.history.location.href
    await screen.findByText('Agent unavailable')
    const picker = screen.getByRole('combobox', { name: 'Agent' })
    expect(picker).toHaveValue('')
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select agent', 'Removed Coder'])
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(source.reads).toHaveLength(0)
    expect(source.current.calls).toHaveLength(0)
    expect(router.history.location.href).toBe(href)
    await userEvent.selectOptions(picker, nodeId)
    await screen.findByText('Reply execution-run-a')
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.every((url) => new URL(url).pathname.endsWith(`/nodes/${nodeId}`))).toBe(true)
    expect(router.history.location.href).toBe(href)
  })

  it('shows no Agents and makes no chat request for a Job-only snapshot', async () => {
    const source = installSelectedHandlers()
    server.use(http.get(snapshotRoute, () => HttpResponse.json(mixedSnapshot(undefined, true))))
    await mountPanel()
    await screen.findByText('No agents')
    expect(within(screen.getByRole('combobox', { name: 'Agent' })).getAllByRole('option')).toHaveLength(1)
    expect(source.reads).toHaveLength(0)
    expect(source.current.calls).toHaveLength(0)
  })
})
