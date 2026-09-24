// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from '../run-graph/cache'
import { RunGraphView } from '../run-graph/RunGraphView'
import type { RunGraphRecord } from '../run-graph/types'
import { fixture } from '../run-graph/testFixtures'
import * as clientApi from './client'

const flow = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../run-graph/sync', () => ({ retainRunGraphSync: () => ({ epoch: 1, retry: vi.fn(), release: vi.fn(), subscribe: () => () => undefined }) }))
vi.mock('../../shared/api/query', () => ({ useStopManagedRunMutation: () => ({ isPending: false, isError: false, isSuccess: false, mutate: vi.fn() }) }))
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrowclosed' },
  Handle: () => null, Background: () => null, Controls: () => null, BaseEdge: () => null,
  getSmoothStepPath: () => ['', 0, 0], ReactFlow: () => { flow.render(); return <div data-testid="second-canvas" /> },
}))
vi.mock('../../shared/ui/nocturne', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/ui/nocturne')>(),
  WorkflowNodeCard: () => null,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); flow.render.mockClear(); vi.restoreAllMocks() })
function setup() {
  const f = fixture('embedded')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  const key = graphRecordKey(f.scope, sessionGeneration())
  const record: RunGraphRecord = { kind: 'run-graph-cache', scope: f.scope, epoch: 1,
    transport: { phase: 'live', confirmedAt: 1 }, facts: { reader: 'graph', snapshot: f.snapshot } }
  client.setQueryData(key, record)
  return { ...f, client, key, record }
}

/** Real Run selectors/presentation, controlled reader/cache. Not a native-provider test. */
describe('Run facts embedded on the authoring board', () => {
  it('does not render a second canvas and still exposes every pinned node', () => {
    const f = setup()
    render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} embedded /></QueryClientProvider>)
    expect(flow.render).not.toHaveBeenCalled()
    expect(screen.queryByTestId('immutable-run-canvas')).toBeNull()
    const select = screen.getByLabelText('Inspect any pinned node')
    for (const node of f.snapshot.topology.nodes) expect(select).toHaveTextContent(node.workflowNodeId)
    fireEvent.change(select, { target: { value: f.identities[0]!.workflowNodeId } })
    expect(screen.getByText(f.identities[0]!.agentConfigurationVersionId)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Run' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save|start|delete|edit/i })).toBeNull()
  })
  it('never labels mutable draft content as historical Run metadata', () => {
    const f = setup()
    const props = { scope: f.scope, embedded: true, draft: { nodes: [{ id: f.identities[0]!.workflowNodeId, name: 'FUTURE-LABEL' }] } }
    render(<QueryClientProvider client={f.client}><RunGraphView {...props} /></QueryClientProvider>)
    expect(screen.queryByText('FUTURE-LABEL')).toBeNull()
    expect(screen.getByText(f.scope.workflowVersionId)).toBeInTheDocument()
  })
  it('requests paginated history only after its explicit control opens', async () => {
    const f = setup()
    const read = vi.spyOn(clientApi, 'readBoardHistory').mockResolvedValue({ items: [], pageInfo: { nextCursor: null } })
    render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} embedded /></QueryClientProvider>)
    expect(read).not.toHaveBeenCalled()
    const details = screen.getByText('Run activity history').closest('details')!
    act(() => { details.open = true; fireEvent(details, new Event('toggle')) })
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(read.mock.calls[0]?.slice(0, 2)).toEqual([f.scope, null])
  })
  it('removes protected facts and history access immediately when the reader is denied', async () => {
    const f = setup()
    render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} embedded /></QueryClientProvider>)
    await act(async () => { f.client.setQueryData<RunGraphRecord>(f.key, { kind: 'run-graph-cache', scope: f.scope,
      epoch: 2, transport: { phase: 'denied', reason: 'GRAPH_READ_ACCESS_DENIED' } }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.queryByLabelText('Inspect any pinned node')).toBeNull()
    expect(screen.queryByText('Run activity history')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop Run' })).toBeNull()
  })
  it('does not retain prior Run facts while a different selected Run loads', () => {
    const f = setup()
    const page = render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} embedded /></QueryClientProvider>)
    const next = fixture('embedded-other')
    page.rerender(<QueryClientProvider client={f.client}><RunGraphView scope={next.scope} embedded /></QueryClientProvider>)
    expect(screen.queryByText(f.scope.workflowVersionId)).toBeNull()
    expect(screen.getByText('Loading confirmed facts…')).toBeInTheDocument()
  })
})
