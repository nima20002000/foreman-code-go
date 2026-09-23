import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType, ReactNode } from 'react'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from './cache'
import { RunGraphView } from './RunGraphView'
import { reduceGraphPage } from './reducer'
import type { RunGraphRecord } from './types'
import type { RunViewNode } from './topology'
import { batch, fixture, page } from './testFixtures'

const flow = vi.hoisted(() => ({ renders: [] as Array<{ nodes: RunViewNode[]; nodesDraggable: boolean; nodesConnectable: boolean; deleteKeyCode: unknown }> }))
vi.mock('./sync', () => ({ retainRunGraphSync: () => ({ epoch: 1, retry: vi.fn(), release: vi.fn(), subscribe: () => () => undefined }) }))
vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' }, Position: { Left: 'left', Right: 'right' },
  Handle: () => null, Background: () => null, Controls: () => null, BaseEdge: () => null,
  getSmoothStepPath: () => ['', 0, 0],
  ReactFlow: (props: { nodes: RunViewNode[]; nodesDraggable: boolean; nodesConnectable: boolean; deleteKeyCode: unknown;
    nodeTypes: Record<string, ComponentType<{ data: RunViewNode['data'] }>>; children: ReactNode }) => {
    flow.renders.push(props)
    return <div data-testid="flow-stub">{props.nodes.map((node) => {
      const Node = props.nodeTypes[node.type!]
      return Node ? <Node key={node.id} data={node.data} /> : null
    })}{props.children}</div>
  },
}))
vi.mock('../../shared/ui/nocturne', () => ({
  WorkflowNodeCard: ({ title, subtitle, statusLabel, meta, ariaLabel, onSelect }: {
    title: string; subtitle: string; statusLabel: string; meta: string; ariaLabel: string; onSelect: () => void;
  }) => <button aria-label={ariaLabel} onClick={onSelect}><span>{title}</span><span>{subtitle}</span><span>{statusLabel}</span><span>{meta}</span></button>,
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
}))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); flow.renders.length = 0 })
function setup() {
  const f = fixture('view')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  const key = graphRecordKey(f.scope, sessionGeneration())
  const record: RunGraphRecord = { kind: 'run-graph-cache', scope: f.scope, epoch: 1,
    transport: { phase: 'live', confirmedAt: 1 }, facts: { reader: 'graph', snapshot: f.snapshot } }
  client.setQueryData(key, record)
  return { ...f, client, key, record }
}

describe('immutable Run view (component checks, not a real React Flow profile)', () => {
  it('uses pinned topology and rejects a draft overlay even when node IDs match', () => {
    const f = setup()
    const props = { scope: f.scope, draft: { nodes: [{ id: f.identities[0]!.workflowNodeId, name: 'FUTURE DRAFT LABEL' }] } }
    render(<QueryClientProvider client={f.client}><RunGraphView {...props} /></QueryClientProvider>)
    expect(screen.queryByText('FUTURE DRAFT LABEL')).toBeNull()
    expect(screen.getByText(f.scope.workflowVersionId)).toBeDefined()
    expect(flow.renders.at(-1)).toMatchObject({ nodesDraggable: false, nodesConnectable: false, deleteKeyCode: null })
    expect(screen.queryByRole('button', { name: /save|start|delete|edit/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop Run' })).toBeDefined()
    expect(screen.getAllByText('Activity unavailable')).toHaveLength(2)
  })
  it('offers Stop only while work or cleanup is pending', async () => {
    const f = setup()
    render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} /></QueryClientProvider>)
    const terminal = { ...f.snapshot, state: { ...f.snapshot.state,
      run: { ...f.snapshot.state.run, executionState: 'completed' as const, outcome: 'succeeded' as const } } }
    await act(async () => { f.client.setQueryData<RunGraphRecord>(f.key, { ...f.record,
      facts: { reader: 'graph', snapshot: terminal } }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.queryByRole('button', { name: 'Stop Run' })).toBeNull()
    await act(async () => { f.client.setQueryData<RunGraphRecord>(f.key, { ...f.record,
      facts: { reader: 'graph', snapshot: { ...terminal, state: { ...terminal.state,
        run: { ...terminal.state.run, cleanupPending: true } } } } }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.getByRole('button', { name: 'Stop Run' })).toBeDefined()
  })
  it('does not rebuild the canvas topology for an activity-only update or a transport change', async () => {
    const f = setup()
    render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} /></QueryClientProvider>)
    const before = flow.renders.length
    const renderedNodes = flow.renders.at(-1)!.nodes
    const updated = reduceGraphPage(f.snapshot, page(f.scope, [batch(f.scope, '1', [
      { type: 'node.activity', activity: { workflowNodeId: f.identities[0]!.workflowNodeId, status: 'none' } },
    ])])).snapshot
    await act(async () => {
      f.client.setQueryData<RunGraphRecord>(f.key, { ...f.record, facts: { reader: 'graph', snapshot: updated },
        transport: { phase: 'stale', confirmedAt: 1, reason: 'NETWORK_ERROR' } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(flow.renders.length).toBe(before)
    expect(flow.renders.at(-1)!.nodes).toBe(renderedNodes)
    expect(screen.getByText('No current activity')).toBeDefined()
    expect(screen.getByText('Updates unavailable; showing last confirmed facts')).toBeDefined()
  })
  it('does not retain the old Run graph while the new selection is loading', () => {
    const f = setup()
    const mounted = render(<QueryClientProvider client={f.client}><RunGraphView scope={f.scope} /></QueryClientProvider>)
    const next = fixture('other-view')
    mounted.rerender(<QueryClientProvider client={f.client}><RunGraphView scope={next.scope} /></QueryClientProvider>)
    expect(screen.queryByTestId('immutable-run-canvas')).toBeNull()
    expect(screen.queryByText(f.scope.workflowVersionId)).toBeNull()
    expect(screen.getByText('Loading confirmed facts…')).toBeDefined()
  })
})
