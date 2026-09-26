// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowDefinitionSchema, WorkspaceDetailsResponseSchema } from '@graphql/contracts'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { WorkspaceRouteEntry } from './WorkspaceRouteEntry'
import { PersistedWorkflowBoundary } from '../features/graph/PersistedWorkflowBoundary'
import { nextDraftApi } from '../features/graph/nextDraft/transport'
import { useGraphDraftStore, workflowDraftKey } from '../features/graph/store'

const route = vi.hoisted(() => ({
  workspaceId: '', workflowId: '', details: null as unknown,
  navigate: vi.fn(), legacyMount: vi.fn(), legacyUnmount: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: `/workspaces/${route.workspaceId}`, search: { workflowId: route.workflowId } }),
  useNavigate: () => route.navigate,
}))
vi.mock('../shared/api/query', () => ({
  queryKeys: {
    workspaceDetails: (id: string) => ['workspace', id], managedWorkflow: (id: string, workflowId: string) => ['managed', id, workflowId],
    agents: (id: string) => ['agents', id], workflow: (workspaceId: string, workflowId: string) => ['workflow', workspaceId, workflowId],
  },
  useWorkspaceDetailsQuery: () => ({ data: route.details, isPending: false, isError: false, refetch: vi.fn() }),
  useManagedWorkflowQuery: () => ({ data: undefined, fetchStatus: 'idle' }),
}))
vi.mock('../features/graph', () => ({
  WorkflowGraph: ({ workflowId }: { workflowId: string }) => {
    useEffect(() => { route.legacyMount(workflowId); return () => { route.legacyUnmount(workflowId) } }, [workflowId])
    return <div data-testid="legacy-editor">Legacy editor: {workflowId}</div>
  },
}))
vi.mock('../features/workflow-board/WorkflowBoard', () => ({
  WorkflowBoard: ({ children }: { children: ReactNode }) => <div data-testid="one-workflow-board">{children}</div>,
}))
vi.mock('../features/graph/nextDraft/NextDraftEditor', () => ({
  NextDraftEditor: ({ workflowId }: { workflowId: string }) => <div data-testid="typed-board-editor">Typed board: {workflowId}</div>,
}))
vi.mock('./WorkspaceRoute', () => ({
  WorkspaceSelection: ({ slots, children }: { slots?: { workspace?: ReactNode; graph?: ReactNode }; children?: ReactNode }) =>
    <section>{slots?.workspace}{slots?.graph}{children}</section>,
}))
const fixture = makeWave25Fixture('wr4-002-web')
const typed = fixture.version.definition
const legacy = WorkflowDefinitionSchema.parse({ id: typed.id, workspaceId: typed.workspaceId, name: 'Legacy original', executionCondition: { kind: 'manual' }, nodes: [], edges: [] })
const sibling = WorkflowDefinitionSchema.parse({ ...legacy, id: 'legacy-sibling', name: 'Legacy sibling' })
const details = (workflows: unknown[]) => WorkspaceDetailsResponseSchema.parse({
  workspace: { id: typed.workspaceId, name: 'Mixed workspace' }, workflows, agents: [], runs: [], resources: [], runners: [],
})

/** Actual route, strict boundary and Query cache. Renderers, router and HTTP are controlled seams;
 * this is not an authenticated browser or native-provider check. */
describe('WR4-002 strict semantics boundary inside the unified board', () => {
  let client: QueryClient
  beforeEach(() => {
    useGraphDraftStore.getState().clearAllDrafts()
    route.workspaceId = typed.workspaceId; route.workflowId = typed.id; route.details = details([legacy, sibling])
    route.navigate.mockClear(); route.legacyMount.mockClear(); route.legacyUnmount.mockClear()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['workspace', typed.workspaceId], route.details)
    vi.spyOn(nextDraftApi, 'context').mockImplementation(async (workspaceId, workflowId) => {
      const graph = (route.details as ReturnType<typeof details>).workflows.find((item) => item.id === workflowId)!
      return { draft: { id: `draft-${workflowId}`, workspaceId, workflowId, revision: 0, publishedRevision: 0,
        baseWorkflowVersionId: fixture.version.id, graph, stagedAgents: [], updatedByPrincipalId: 'test-owner', updatedAt: '2026-09-23T00:00:00.000Z' }, agents: [] }
    })
  })
  afterEach(() => { cleanup(); client.clear(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })
  const page = () => <QueryClientProvider client={client}><WorkspaceRouteEntry /></QueryClientProvider>
  it('fresh typed navigation mounts board authoring, never the legacy editor or standalone link', async () => {
    route.details = details([typed, sibling]); render(page())
    expect(await screen.findByTestId('typed-board-editor')).toBeTruthy()
    expect(screen.getAllByTestId('one-workflow-board')).toHaveLength(1)
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
    expect(route.legacyMount).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Open typed draft editor' })).toBeNull()
    expect(client.getQueryData(['workflow', typed.workspaceId, typed.id])).toEqual({ workflow: typed })
  })
  it('changes the clean authoring adapter after external publication without downcasting data', async () => {
    const mounted = render(page()); await screen.findByTestId('legacy-editor')
    expect(route.legacyMount).toHaveBeenCalledOnce()
    route.details = details([typed, sibling]); client.setQueryData(['workspace', typed.workspaceId], route.details)
    mounted.rerender(page()); await screen.findByTestId('typed-board-editor')
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
    expect(route.legacyUnmount).toHaveBeenCalledWith(typed.id)
    expect(route.legacyMount).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['workflow', typed.workspaceId, typed.id])).toEqual({ workflow: typed })
    mounted.unmount(); route.legacyMount.mockClear(); render(page())
    await screen.findByTestId('typed-board-editor'); expect(route.legacyMount).not.toHaveBeenCalled()
  })
  it('switches to a legacy sibling and back without passing v2 into the legacy editor', async () => {
    route.details = details([typed, sibling]); const mounted = render(page())
    await screen.findByTestId('typed-board-editor')
    route.workflowId = sibling.id; mounted.rerender(page())
    expect((await screen.findByTestId('legacy-editor')).textContent).toContain(sibling.id)
    route.workflowId = typed.id; mounted.rerender(page()); await screen.findByTestId('typed-board-editor')
    expect(route.legacyMount.mock.calls).toEqual([[sibling.id]])
  })
  it('does not overwrite occupied legacy edits when another writer publishes typed semantics', async () => {
    const local = { workflow: legacy, agentOverrides: {}, dirty: true as const }
    useGraphDraftStore.setState({ drafts: { [workflowDraftKey(typed.workspaceId, typed.id)]: local } })
    route.details = details([typed]); render(page())
    await waitFor(() => expect(screen.getByText('Local legacy edits are retained')).toBeTruthy())
    expect(useGraphDraftStore.getState().drafts[workflowDraftKey(typed.workspaceId, typed.id)]).toBe(local)
    expect(screen.queryByTestId('typed-board-editor')).toBeNull()
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
  })
  it.each([
    { ...typed, executionSemanticsVersion: 3 }, { ...typed, entryNodeId: undefined },
    { ...typed, edges: typed.edges.map((edge) => ({ ...edge, kind: undefined })) },
    { ...legacy, workspaceId: 'another-workspace' }, { ...legacy, id: 'another-workflow' },
  ])('fails closed before mounting a renderer for malformed or cross-scope records %#', (workflow) => {
    render(<PersistedWorkflowBoundary workspaceId={typed.workspaceId} workflowId={typed.id} workflow={workflow}>
      <div data-testid="legacy-editor">Must not mount</div>
    </PersistedWorkflowBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.queryByTestId('legacy-editor')).toBeNull()
  })
})
