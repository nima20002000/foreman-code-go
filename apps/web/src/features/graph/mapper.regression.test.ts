import { describe, expect, it } from 'vitest'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { workflowToGraph } from './mapper'
import { applyGraphGeometry, createGraphGeometryAdapter } from './geometry'
import { putRelationship, removeRelationship } from './nextDraft/model'

describe('current V3 geometry and explicit typed relationships', () => {
  it.each([false, true])('preserves exact executable meaning and optional-repeat absence (drag=%s)', (drag) => {
    const { version } = currentWorkflowFixture('geometry'), graph = version.definition, before = structuredClone(graph)
    const rendered = workflowToGraph({ workflow: graph, agents: [] })
    const result = applyGraphGeometry(graph, drag ? [{ id: graph.nodes[0]!.id, position: { x: 150, y: -250 } }] : [])
    expect(result.edges).toBe(graph.edges); expect(result.executionSemanticsVersion).toBe(3)
    expect(result).not.toHaveProperty('repeat'); expect(graph).toEqual(before)
    expect(rendered.edges[0]?.data?.explanation).toEqual(expect.any(String))
  })
  it('cannot change relationship meaning under an existing ID and does not resurrect removals', () => {
    const graph = currentWorkflowFixture('relationship').version.definition, edge = graph.edges[0]!
    expect(() => putRelationship(graph, { ...edge, kind: 'approval' })).toThrow(/identity/)
    const removed = removeRelationship(graph, edge.id)
    expect(applyGraphGeometry(removed, [{ id: graph.nodes[0]!.id, position: { x: 9, y: 8 } }]).edges).toEqual([])
  })
  it('keeps React Flow measurement out of persisted geometry and flushes a drag once', () => {
    const graph = currentWorkflowFixture('buffer').version.definition
    const rendered = workflowToGraph({ workflow: graph, agents: [] }), adapter = createGraphGeometryAdapter(rendered.nodes)
    adapter.update([{ type: 'dimensions', id: graph.nodes[0]!.id, dimensions: { width: 200, height: 100 } }])
    expect(adapter.flush()).toEqual([])
    adapter.update([{ type: 'position', id: graph.nodes[0]!.id, position: { x: 121, y: 97 }, dragging: true }])
    adapter.update([{ type: 'position', id: graph.nodes[0]!.id, dragging: false }])
    expect(adapter.flush()).toEqual([{ id: graph.nodes[0]!.id, position: { x: 121, y: 97 } }])
    expect(adapter.flush()).toEqual([])
  })
})
