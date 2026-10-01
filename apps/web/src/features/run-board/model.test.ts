import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'
import { projectRunBoard, READ_ONLY_FLOW_PROPS } from './model'
import { savedEdgeCurve } from './curve'
import { runA, runB } from './testFixtures'

describe('saved board projection', () => {
  it('preserves exact nodes, names, configuration pins, order, coordinates and sizes', () => {
    const result = projectRunBoard(runA)
    expect(result.nodes.map((node) => node.id)).toEqual(runA.nodes.map((node) => node.id))
    for (const [index, node] of result.nodes.entries()) {
      const saved = nativeNode(runA.nodes[index]!)
      expect(node.data.snapshot).toBe(saved)
      expect(node.position).toEqual(saved.position)
      expect(node.position).not.toBe(saved.position)
      expect(node.style).toEqual({ width: saved.size.width, height: saved.size.height })
      expect(node.initialWidth).toBe(saved.size.width)
      expect(node.initialHeight).toBe(saved.size.height)
      expect(node.ariaLabel).toContain(saved.name)
      expect(node.domAttributes?.title).toContain(saved.agentConfigurationVersionId)
    }
    expect(projectRunBoard(runB).nodes.map((node) => node.id)).not.toContain('node-y')
  })
  it('never installs mutable canvas geometry into the frozen snapshot', () => {
    const before = JSON.stringify(runA)
    const result = projectRunBoard(runA)
    nativeNode(result.nodes[0]!).position.x = 999
    nativeNode(result.nodes[0]!).style!.width = 999
    result.nodes.splice(1, 1)
    result.edges.pop()
    expect(JSON.stringify(runA)).toBe(before)
    expect(Object.isFrozen(runA)).toBe(true)
    expect(Object.isFrozen(nativeNode(runA.nodes[0]!).position)).toBe(true)
  })
  it('keeps approval and execution edges distinct, including handles, labels and policy', () => {
    const { edges } = projectRunBoard(runA)
    expect(edges.map((edge) => edge.id)).toEqual(['edge-xy', 'approval-xy', 'edge-yz'])
    expect(edges[0]).toMatchObject({ source: 'node-x', target: 'node-y', sourceHandle: 'bottom', targetHandle: 'top' })
    expect(edges[0]!.data!.snapshot).toBe(runA.edges[0])
    expect(edges[0]!.data!.snapshot.maxWorkHandoffsPerRun).toBe(3)
    expect(edges[0]!.data!.lane).not.toBe(edges[1]!.data!.lane)
    expect(edges[2]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' })
  })
  it('locks keyboard, drag, connect, reconnect and delete at both canvas and object levels', () => {
    expect(READ_ONLY_FLOW_PROPS).toMatchObject({ nodesDraggable: false, nodesConnectable: false,
      edgesReconnectable: false, elementsSelectable: false, connectOnClick: false,
      disableKeyboardA11y: true, deleteKeyCode: null })
    const { nodes, edges } = projectRunBoard(runA)
    for (const node of nodes) expect(node).toMatchObject({ draggable: false, connectable: false, selectable: false, deletable: false })
    for (const edge of edges) expect(edge).toMatchObject({ selectable: false, reconnectable: false, deletable: false })
  })
})

describe('saved edge geometry', () => {
  const input = { sourceX: 10, sourceY: 20, targetX: 500, targetY: 200,
    sourcePosition: Position.Bottom, targetPosition: Position.Top, lane: 0, loop: false }
  it('uses the actual saved handle endpoints and has finite chevron geometry', () => {
    const curve = savedEdgeCurve(input)
    expect(curve.path).toMatch(/^M 10,20 C /)
    expect(curve.path).toMatch(/ 500,200$/)
    expect(Object.values(curve.mid).every(Number.isFinite)).toBe(true)
    expect(savedEdgeCurve({ ...input, lane: 1 }).path).not.toBe(curve.path)
  })
  it('handles all four sides and coincident/self edges without NaN', () => {
    for (const side of Object.values(Position)) {
      const curve = savedEdgeCurve({ ...input, sourcePosition: side, targetPosition: side,
        targetX: input.sourceX, targetY: input.sourceY, loop: true })
      expect(curve.path).not.toMatch(/NaN|Infinity/)
      expect(Object.values(curve.mid).every(Number.isFinite)).toBe(true)
    }
  })
})
