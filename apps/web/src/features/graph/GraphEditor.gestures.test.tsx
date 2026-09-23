import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactFlowProps } from '@xyflow/react'
import type { SaveWorkflowRequest, SaveWorkflowResponse } from '@graphql/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphEditor } from './GraphEditor'
import { makeScaleGraph } from './fixtures/scaleData'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import type { GraphNode, GraphEdge } from './types'

const flow = vi.hoisted(() => ({ props: null as ReactFlowProps<GraphNode, GraphEdge> | null }))
const transport = vi.hoisted(() => ({ save: vi.fn<(input: SaveWorkflowRequest) => Promise<SaveWorkflowResponse>>() }))
vi.mock('../../shared/api/client', async () => ({
  ...await vi.importActual<typeof import('../../shared/api/client')>('../../shared/api/client'), saveGraph: transport.save,
}))
vi.mock('@tanstack/react-router', async () => ({
  ...await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router'),
  Link: ({ children }: { children: import('react').ReactNode }) => <a href="#">{children}</a>,
}))
vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  ReactFlow: (props: ReactFlowProps<GraphNode, GraphEdge>) => { flow.props = props; return <div /> },
  Background: () => null, MiniMap: () => null,
}))
vi.mock('./GraphElements', () => ({ AgentNode: () => null, AgentMinimapDot: () => null, HandoffEdge: () => null }))

afterEach(() => { useGraphDraftStore.getState().clearAllDrafts(); sessionStorage.clear(); transport.save.mockReset() })

function setup() {
  const source = makeScaleGraph(2)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const renderView = () => <QueryClientProvider client={client}><GraphEditor
    workspaceId={source.workflow.workspaceId} workflow={source.workflow} agents={source.agents} /></QueryClientProvider>
  const view = render(renderView())
  const key = workflowDraftKey(source.workflow.workspaceId, source.workflow.id)
  const move = (x: number, start = true) => act(() => {
    const node = flow.props!.nodes![0]
    if (start) flow.props!.onNodeDragStart?.({} as never, node, [node])
    flow.props!.onNodesChange?.([{ type: 'position', id: node.id, position: { x, y: 42 }, dragging: true }])
  })
  const finish = () => act(() => flow.props!.onNodesChange?.([{ type: 'position', id: source.workflow.nodes[0].id, dragging: false }]))
  const unmount = () => { view.unmount(); client.clear() }
  return { ...view, source, key, move, finish, unmount }
}

describe('editor gesture/save/Undo integration (mocked renderer, not a benchmark)', () => {
  it('flushes the final pointer position into Save before a terminal pointer event', async () => {
    transport.save.mockImplementation(async (input) => ({ workflow: input.workflow, agents: [] }))
    const view = setup()
    view.move(10); view.move(241, false)
    expect(getGraphDraft(view.key)).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledTimes(1))
    expect(transport.save.mock.calls[0][0].workflow.nodes[0].position).toEqual({ x: 241, y: 42 })
    await waitFor(() => expect(getGraphDraft(view.key)).toBeUndefined())
    view.unmount()
  })

  it('retains newer in-flight geometry when an earlier save is acknowledged', async () => {
    let resolve!: (value: SaveWorkflowResponse) => void
    transport.save.mockImplementation(() => new Promise((done) => { resolve = done }))
    const view = setup()
    view.move(100); view.finish()
    fireEvent.click(screen.getByRole('button', { name: 'Save graph' }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledTimes(1))
    const submitted = transport.save.mock.calls[0][0].workflow
    view.move(900)
    // The second gesture is still renderer-local until the first save settles.
    expect(getGraphDraft(view.key)?.workflow.nodes[0].position?.x).toBe(100)
    await act(async () => resolve({ workflow: submitted, agents: [] }))
    await waitFor(() => expect(getGraphDraft(view.key)?.workflow.nodes[0].position?.x).toBe(900))
    expect(screen.getByText('Graph saved. Newer local changes remain unsaved.')).toBeVisible()
    fireEvent.keyDown(screen.getByTestId('workflow-graph'), { key: 'z', ctrlKey: true })
    expect(getGraphDraft(view.key)?.workflow.nodes[0].position?.x).toBe(100)
    view.unmount()
  })

  it('creates one Undo step for a complete gesture, and Discard cannot flush canceled geometry back', () => {
    const view = setup()
    view.move(10)
    for (let x = 11; x <= 50; x++) view.move(x, false)
    view.finish()
    expect(getGraphDraft(view.key)?.workflow.nodes[0].position?.x).toBe(50)
    fireEvent.keyDown(screen.getByTestId('workflow-graph'), { key: 'z', ctrlKey: true })
    expect(getGraphDraft(view.key)).toBeUndefined()
    view.move(99)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    view.finish()
    expect(getGraphDraft(view.key)).toBeUndefined()
    view.unmount()
    expect(getGraphDraft(view.key)).toBeUndefined()
  })

  it('preserves an interrupted gesture in the scoped draft on navigation without saving remotely', () => {
    const view = setup()
    view.move(321)
    view.unmount()
    expect(getGraphDraft(view.key)?.workflow.nodes[0].position).toEqual({ x: 321, y: 42 })
    expect(transport.save).not.toHaveBeenCalled()
  })
})
