// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowDefinitionSchema, WorkspaceDetailsResponseSchema } from '@graphql/contracts'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { WorkspaceRouteEntry } from './WorkspaceRouteEntry'
import { PersistedWorkflowBoundary } from '../features/graph/PersistedWorkflowBoundary'

const route = vi.hoisted(() => ({
  workspaceId: '', workflowId: '', details: null as unknown,
  navigate: vi.fn(), legacyMount: vi.fn(), legacyUnmount: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ workspaceId: route.workspaceId }),
  useSearch: () => ({ workflowId: route.workflowId }),
  useNavigate: () => route.navigate,
  Link: ({ children, params }: { children: ReactNode; params: { workspaceId: string; workflowId: string } }) =>
    <a href={`/workspaces/${encodeURIComponent(params.workspaceId)}/workflows/${encodeURIComponent(params.workflowId)}/draft`}>{children}</a>,
}))
vi.mock('../shared/api/query', () => ({
  queryKeys: {
    workspaceDetails: (id: string) => ['workspace', id],
    managedWorkflows: (id: string) => ['managed', id],
    agents: (id: string) => ['agents', id],
    workflow: (workspaceId: string, workflowId: string) => ['workflow', workspaceId, workflowId],
  },
  useWorkspaceDetailsQuery: () => ({ data: route.details, isPending: false, isError: false, refetch: vi.fn() }),
  useManagedWorkflowsQuery: () => ({ data: undefined, fetchStatus: 'idle' }),
}))
vi.mock('../features/graph', () => ({
  WorkflowGraph: ({ workflowId }: { workflowId: string }) => {
    useEffect(() => {
      route.legacyMount(workflowId)
      return () => { route.legacyUnmount(workflowId) }
    }, [workflowId])
    return <div data-testid="legacy-editor">Legacy editor: {workflowId}</div>
  },
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

/** Mounts the actual route and strict boundary with real QueryClient cache
 * projection. Router selection and server-query responses are controlled seams;
 * this is NOT an authenticated browser, network or full graph renderer test. */
describe('WR4-002 persisted workflow route boundary', () => {
  let queryClient: QueryClient
  beforeEach(() => {
    route.workspaceId = typed.workspaceId
    route.workflowId = typed.id
    route.details = details([legacy, sibling])
    route.navigate.mockClear(); route.legacyMount.mockClear(); route.legacyUnmount.mockClear()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['workspace', typed.workspaceId], route.details)
  })
  afterEach(() => { cleanup(); queryClient.clear() })
  const page = (client: QueryClient) => <QueryClientProvider client={client}><WorkspaceRouteEntry /></QueryClientProvider>

  it('a fresh typed workspace navigation never mounts the legacy editor', () => {
    route.details = details([typed, sibling])
    render(page(queryClient))
    const view = screen.getByTestId('persisted-workflow-v2')
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
    expect(route.legacyMount).not.toHaveBeenCalled()
    expect(within(view).getByRole('link', { name: 'Open typed draft editor' }).getAttribute('href'))
      .toBe(`/workspaces/${typed.workspaceId}/workflows/${typed.id}/draft`)
    expect(queryClient.getQueryData(['workflow', typed.workspaceId, typed.id])).toEqual({ workflow: typed })
    expect(view.querySelector('pre')).toBeNull()
    const definitionDetails = within(view).getByText('Exact saved definition, including choices and relationship kinds').closest('details')!
    definitionDetails.open = true
    fireEvent(definitionDetails, new Event('toggle'))
    expect(view.querySelector('pre')?.textContent).toContain('executionSemanticsVersion')
  })
  it('replaces the mounted legacy editor after a publication refresh without downcasting the cache', () => {
    const mounted = render(page(queryClient))
    expect(route.legacyMount).toHaveBeenCalledOnce()
    expect(screen.getByTestId('legacy-editor')).toBeTruthy()
    route.details = details([typed, sibling])
    queryClient.setQueryData(['workspace', typed.workspaceId], route.details)
    mounted.rerender(page(queryClient))
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
    expect(route.legacyUnmount).toHaveBeenCalledWith(typed.id)
    expect(route.legacyMount).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('persisted-workflow-v2').textContent).toContain('execution')
    expect(queryClient.getQueryData(['workflow', typed.workspaceId, typed.id])).toEqual({ workflow: typed })
    // Reload/navigation uses the persisted tag again, not a disposable editor flag.
    mounted.unmount()
    route.legacyMount.mockClear()
    render(page(queryClient))
    expect(screen.getByTestId('persisted-workflow-v2')).toBeTruthy()
    expect(route.legacyMount).not.toHaveBeenCalled()
  })
  it('can navigate to the legacy sibling and back without mounting v2 in the legacy editor', () => {
    route.details = details([typed, sibling])
    const mounted = render(page(queryClient))
    route.workflowId = sibling.id
    mounted.rerender(page(queryClient))
    expect(screen.getByTestId('legacy-editor').textContent).toContain(sibling.id)
    expect(route.legacyMount.mock.calls).toEqual([[sibling.id]])
    route.workflowId = typed.id
    mounted.rerender(page(queryClient))
    expect(screen.getByTestId('persisted-workflow-v2')).toBeTruthy()
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
    expect(route.legacyMount.mock.calls).toEqual([[sibling.id]])
  })
  it.each([
    { ...typed, executionSemanticsVersion: 3 },
    { ...typed, entryNodeId: undefined },
    { ...typed, edges: typed.edges.map((edge) => ({ ...edge, kind: undefined })) },
    { ...legacy, workspaceId: 'another-workspace' },
    { ...legacy, id: 'another-workflow' },
  ])('fails closed before mounting legacy children for malformed or cross-scope records %#', (workflow) => {
    render(<PersistedWorkflowBoundary workspaceId={typed.workspaceId} workflowId={typed.id} workflow={workflow}>
      <div data-testid="legacy-editor">Must not mount</div>
    </PersistedWorkflowBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByTestId('legacy-editor')).toBeNull()
  })
})
