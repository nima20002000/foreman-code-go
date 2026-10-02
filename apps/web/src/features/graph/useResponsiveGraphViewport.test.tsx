import { act, fireEvent, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResponsiveGraphViewport, RESPONSIVE_FIT_OPTIONS } from './useResponsiveGraphViewport'

class FakeObserver {
  static all: FakeObserver[] = []
  disconnect = vi.fn()
  observe = vi.fn()
  constructor(private cb: ResizeObserverCallback) { FakeObserver.all.push(this) }
  size(width: number, height: number) {
    this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

function Harness({ flow, enabled = true }: { flow: unknown; enabled?: boolean }) {
  const { containerRef, onInit } = useResponsiveGraphViewport({ enabled })
  useEffect(() => { onInit(flow as never) }, [flow, onInit])
  return <div ref={containerRef} data-testid="canvas" />
}
const settle = () => act(() => { vi.advanceTimersByTime(100) })

describe('responsive graph viewport', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeObserver.all = []; vi.stubGlobal('ResizeObserver', FakeObserver) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const make = () => ({ fitView: vi.fn(async () => true), getNodes: vi.fn(() => [{ id: 'a', position: { x: 1, y: 2 } }]) })

  it('refits to the measured size on resize without touching node geometry', () => {
    const flow = make()
    const nodes = flow.getNodes()
    render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(1100, 800)); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
    act(() => ro.size(390, 800)); act(() => ro.size(320, 800)); settle()
    expect(flow.fitView).toHaveBeenCalledTimes(1)
    expect(flow.fitView).toHaveBeenCalledWith({ ...RESPONSIVE_FIT_OPTIONS, duration: 0 })
    expect(RESPONSIVE_FIT_OPTIONS.minZoom).toBeLessThanOrEqual(0.15)
    expect(nodes[0]!.position).toEqual({ x: 1, y: 2 })
  })

  it('ignores hidden, unchanged and rerender-only measurements', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600)); act(() => ro.size(0, 0)); act(() => ro.size(800, 600)); settle()
    view.rerender(<Harness flow={flow} />); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('keeps a user-panned view on height-only changes but refits on width changes', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600))
    fireEvent.pointerDown(view.getByTestId('canvas'))
    act(() => ro.size(800, 500)); settle()
    expect(flow.fitView).not.toHaveBeenCalled()
    act(() => ro.size(390, 500)); settle()
    expect(flow.fitView).toHaveBeenCalledTimes(1)
  })

  it('cancels pending fits and disconnects on unmount', () => {
    const flow = make()
    const view = render(<Harness flow={flow} />)
    const ro = FakeObserver.all[0]!
    act(() => ro.size(800, 600)); act(() => ro.size(390, 600))
    view.unmount(); settle()
    expect(ro.disconnect).toHaveBeenCalled()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it('does not observe while disabled (hidden selected Run)', () => {
    render(<Harness flow={make()} enabled={false} />)
    expect(FakeObserver.all).toHaveLength(0)
  })
})
