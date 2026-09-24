import { describe, expect, it } from 'vitest'
import { AGENT_NODE_SIZE, edgeBend, floatingCurve } from './signalEdge'

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
