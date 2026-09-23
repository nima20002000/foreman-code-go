import { describe, expect, it } from 'vitest'
import { applyGraphGeometry, createGraphGeometryAdapter } from './geometry'
import { createGraphTopologyProjector } from './topology'
import { makeScaleGraph } from './fixtures/scaleData'

function setup() {
  const { workflow, agents } = makeScaleGraph(3)
  const graph = createGraphTopologyProjector()(workflow, agents)
  return { workflow, graph, adapter: createGraphGeometryAdapter(graph.nodes) }
}

describe('gesture-local geometry', () => {
  it('buffers many pointer positions and flushes one final record even when dragging:false has no position', () => {
    const { adapter, workflow, graph } = setup()
    for (let x = 1; x <= 50; x++) {
      expect(adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x, y: 37 }, dragging: true }]).finished).toBe(false)
    }
    expect(workflow.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(adapter.getNodes()[1]).toBe(graph.nodes[1])
    expect(adapter.update([{ type: 'position', id: 'synthetic-node-0', dragging: false }]).finished).toBe(true)
    expect(adapter.flush()).toEqual([{ id: 'synthetic-node-0', position: { x: 50, y: 37 } }])
    expect(adapter.flush()).toEqual([])
    expect(adapter.getNodes()[0].position).toEqual({ x: 50, y: 37 })
  })

  it('waits for every member of a multi-node drag before committing once', () => {
    const { adapter } = setup()
    adapter.update([0, 1].map((index) => ({ type: 'position', id: `synthetic-node-${index}`,
      position: { x: index * 300 + 25, y: 25 }, dragging: true })))
    expect(adapter.update([{ type: 'position', id: 'synthetic-node-0', dragging: false }]).finished).toBe(false)
    expect(adapter.update([{ type: 'position', id: 'synthetic-node-1', dragging: false }]).finished).toBe(true)
    expect(adapter.flush()).toHaveLength(2)
  })

  it('commits top-left resize position and clamped dimensions atomically', () => {
    const { adapter } = setup()
    adapter.beginResize()
    expect(adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x: -20, y: -30 } }]).finished).toBe(false)
    adapter.update([{ type: 'dimensions', id: 'synthetic-node-0', dimensions: { width: 260, height: 160 }, resizing: true }])
    adapter.finishResize('synthetic-node-0', 10_000, 10, { x: -41, y: -51 })
    expect(adapter.flush()).toEqual([{ id: 'synthetic-node-0', position: { x: -41, y: -51 }, width: 520, height: 112 }])
  })

  it('does not turn measurements, selection or invalid coordinates into an edit', () => {
    const { adapter } = setup()
    adapter.update([{ type: 'dimensions', id: 'synthetic-node-0', dimensions: { width: 240, height: 160 } },
      { type: 'select', id: 'synthetic-node-0', selected: true },
      { type: 'position', id: 'synthetic-node-0', position: { x: NaN, y: Infinity }, dragging: false }])
    expect(adapter.flush()).toEqual([])
  })

  it('cancels pending positions and does not leak them into the next gesture', () => {
    const { graph, adapter } = setup()
    adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x: 999, y: 888 }, dragging: true }])
    expect(adapter.cancel()).toBe(graph.nodes)
    expect(adapter.flush()).toEqual([])
    adapter.update([{ type: 'position', id: 'synthetic-node-1', position: { x: 444, y: 333 } }])
    expect(adapter.flush()).toEqual([{ id: 'synthetic-node-1', position: { x: 444, y: 333 } }])
  })

  it('overlays transient geometry without overwriting remote metadata or resurrecting removed nodes', () => {
    const { workflow, graph, adapter } = setup()
    adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x: 98, y: 76 }, dragging: true }])
    const renamed = { ...graph.nodes[0], data: { ...graph.nodes[0].data, label: 'Changed elsewhere' } }
    const rendered = adapter.reconcile([renamed, ...graph.nodes.slice(1)], new Set(['synthetic-node-0']))
    expect(rendered[0].position).toEqual({ x: 98, y: 76 })
    expect(rendered[0].data.label).toBe('Changed elsewhere')
    expect(rendered[1]).toBe(graph.nodes[1])
    const changes = adapter.flush()
    const newer = { ...workflow, name: 'Remote name', nodes: workflow.nodes.slice(1) }
    expect(applyGraphGeometry(newer, changes)).toBe(newer)
    expect(applyGraphGeometry({ ...workflow, name: 'Remote name' }, changes).name).toBe('Remote name')
  })

  it('prunes pending changes for removed nodes and keeps selected unaffected nodes stable', () => {
    const { graph, adapter } = setup()
    adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x: 1, y: 1 }, dragging: true }])
    const selected = adapter.reconcile(graph.nodes.slice(1), new Set(['synthetic-node-1']))
    expect(selected[0].selected).toBe(true)
    expect(selected[1]).toBe(graph.nodes[2])
    expect(adapter.flush()).toEqual([])
  })

  it('preserves metadata, connections and unchanged workflow-node references on a committed move', () => {
    const { workflow } = setup()
    const next = applyGraphGeometry(workflow, [{ id: workflow.nodes[0].id, position: { x: 1, y: 2 } }])
    expect(next.edges).toBe(workflow.edges)
    expect(next.nodes[1]).toBe(workflow.nodes[1])
    expect(next.nodes[0].agentId).toBe(workflow.nodes[0].agentId)
    expect(applyGraphGeometry(next, [{ id: next.nodes[0].id, position: { x: 1, y: 2 } }])).toBe(next)
  })

  it('keeps graph selection through a canceled gesture', () => {
    const { graph, adapter } = setup()
    adapter.reconcile(graph.nodes, new Set(['synthetic-node-0']))
    adapter.update([{ type: 'position', id: 'synthetic-node-0', position: { x: 90, y: 80 }, dragging: true }])
    const canceled = adapter.cancel()
    expect(canceled[0].position).toEqual(graph.nodes[0].position)
    expect(canceled[0].selected).toBe(true)
    expect(canceled[1]).toBe(graph.nodes[1])
  })

})
