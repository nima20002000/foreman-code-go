import { describe, expect, it } from 'vitest'
import { AGENT_NODE_SIZE, edgeBend, floatingCurve, relationshipLines } from './signalEdge'

describe('floating agent connections', () => {
  it('leaves and enters each circle on its rim, not at a fixed side handle', () => {
    const curve = floatingCurve({ x: 0, y: 0 }, { x: 600, y: 0 }, 0)
    const [start, end] = [...curve.path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => Number(match[1]))
      .filter((_, index, all) => index === 0 || index === all.length - 1)
    expect(start).toBeCloseTo(AGENT_NODE_SIZE / 2 + 7)
    expect(end).toBeCloseTo(600 - AGENT_NODE_SIZE / 2 - 7)
    expect(curve.mid.angle).toBeCloseTo(0)
  })
  it('fans parallel connections out instead of overlapping them', () => {
    expect(new Set([0, 1, 2].map((index) => edgeBend(index, true))).size).toBe(3)
  })
})

describe('relationship lines', () => {
  it('draws an approval beside a handoff on the handoff line, flipped when it runs the other way', () => {
    const { lines, alias } = relationshipLines([
      { id: 'review', kind: 'approval' as const, source: 'a', target: 'b' },
      { id: 'handoff', kind: 'execution' as const, source: 'a', target: 'b' },
      { id: 'back', kind: 'approval' as const, source: 'c', target: 'a' },
      { id: 'ca', kind: 'execution' as const, source: 'a', target: 'c' },
      { id: 'lonely', kind: 'approval' as const, source: 'a', target: 'd' },
    ])
    expect(lines.map((line) => [line.id, line.members.map((member) => member.id)])).toEqual([['handoff', ['handoff', 'review']], ['ca', ['ca', 'back']], ['lonely', ['lonely']]])
    expect(alias.get('review')).toEqual({ lineId: 'handoff', flipped: false })
    expect(alias.get('back')).toEqual({ lineId: 'ca', flipped: true })
  })
})
