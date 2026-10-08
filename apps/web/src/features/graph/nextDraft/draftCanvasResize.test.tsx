import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GraphPresentationProvider } from '../GraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow'), context = fixture()
const geometry = vi.fn(), change = vi.fn()
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.width) || 1000
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.height) || 800
  })
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
  geometry.mockClear(); change.mockClear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); useGraphDraftStore.getState().clearAllDrafts() })

function Zoom() {
  const flow = useReactFlow()
  return <button onClick={() => void flow.setViewport({ x: 0, y: 0, zoom: 0.1 })}>Minimum zoom</button>
}
function FixtureCanvas() {
  const [graph, setGraph] = useState(context.draft.graph)
  return <><DraftCanvas draftKey={key} graph={graph} agents={context.agents.map((item) => item.agent)} kind="execution"
    change={change} geometry={(changes: GraphGeometryChange[]) => {
      geometry(changes); setGraph((value) => applyGraphGeometry(value, changes))
    }} pending={vi.fn()} report={vi.fn()} /><Zoom /></>
}
function mount() {
  return render(<GraphPresentationProvider><ReactFlowProvider><FixtureCanvas /></ReactFlowProvider></GraphPresentationProvider>)
}
function mouse(target: Element | Window, type: 'mousedown' | 'mousemove' | 'mouseup', clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1 })
  // Vitest's Window proxy is not accepted by jsdom 30's UIEvent constructor.
  Object.defineProperty(event, 'view', { value: document.defaultView })
  fireEvent(target, event)
}

it.each(['pan', 'wheel zoom'])('preserves the draft viewport after a manual %s and canvas resize', async (gesture) => {
  const layout = installFlowLayout(1000, 800)
  const { container } = mount()
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport')!
  await waitFor(() => expect(viewport.style.transform).toContain('scale(1)'))
  const initial = viewport.style.transform
  const pane = container.querySelector('.react-flow__pane')!
  if (gesture === 'pan') {
    mouse(pane, 'mousedown', 200, 200)
    mouse(document.defaultView!, 'mousemove', 250, 240)
    mouse(document.defaultView!, 'mouseup', 250, 240)
  } else {
    fireEvent.wheel(pane, { deltaY: -100, clientX: 200, clientY: 200 })
  }
  await waitFor(() => expect(viewport.style.transform).not.toBe(initial))
  const adjusted = viewport.style.transform
  act(() => layout.resize(320, 480))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(viewport.style.transform).toBe(adjusted)
  expect(geometry).not.toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
})

it('refits the draft after a stationary canvas click and resize', async () => {
  const layout = installFlowLayout(1000, 800)
  const { container } = mount()
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport')!
  await waitFor(() => expect(viewport.style.transform).toContain('scale(1)'))
  const initial = viewport.style.transform
  const pane = container.querySelector('.react-flow__pane')!
  mouse(pane, 'mousedown', 200, 200)
  mouse(document.defaultView!, 'mouseup', 200, 200)
  expect(viewport.style.transform).toBe(initial)
  act(() => layout.resize(320, 480))
  await waitFor(() => expect(viewport.style.transform).not.toBe(initial))
  const zoom = Number(/scale\(([-\d.]+)\)/.exec(viewport.style.transform)![1])
  expect(zoom).toBeLessThan(1)
  expect(geometry).not.toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
})

it('resizes from a corner at minimum zoom in graph coordinates without moving or connecting the node', async () => {
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Node 0, / }))
  const corner = await waitFor(() => {
    const control = container.querySelector('.react-flow__node[data-id="node-0"] .board-agent-resize-handle.bottom.right')
    expect(control).not.toBeNull(); return control!
  })
  fireEvent.click(screen.getByRole('button', { name: 'Minimum zoom' }))
  await waitFor(() => expect(container.querySelector('.react-flow__viewport')?.getAttribute('style')).toContain('scale(0.1)'))
  expect(container.querySelector<HTMLElement>('.board-agent-resize-line')?.style.getPropertyValue('--resize-hit-size')).toBe('100px')
  const view = document.defaultView!
  mouse(corner, 'mousedown', 22, 22)
  mouse(view, 'mousemove', 30, 27)
  mouse(view, 'mouseup', 30, 27)
  await waitFor(() => expect(geometry).toHaveBeenCalledOnce())
  expect(geometry).toHaveBeenCalledWith([{ id: 'node-0', width: 292, height: 262 }])
  expect(container.querySelector('.react-flow__node[data-id="node-0"]')).toHaveStyle({ width: '292px', height: '262px' })
  expect(change).not.toHaveBeenCalled()
  // Resizing clears the click-to-connect source armed by selecting the node.
  fireEvent.click(screen.getByRole('button', { name: /^Node 1, / }))
  expect(change).not.toHaveBeenCalled()
})

it('keeps the opposite rim anchored while resizing the top-left corner', async () => {
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Node 0, / }))
  const corner = await waitFor(() => {
    const control = container.querySelector('.react-flow__node[data-id="node-0"] .board-agent-resize-handle.top.left')
    expect(control).not.toBeNull(); return control!
  })
  fireEvent.click(screen.getByRole('button', { name: 'Minimum zoom' }))
  await waitFor(() => expect(container.querySelector('.react-flow__viewport')?.getAttribute('style')).toContain('scale(0.1)'))
  mouse(corner, 'mousedown', 0, 0)
  mouse(document.defaultView!, 'mousemove', -4, -3)
  mouse(document.defaultView!, 'mouseup', -4, -3)
  await waitFor(() => expect(geometry).toHaveBeenCalledOnce())
  expect(geometry).toHaveBeenCalledWith([{ id: 'node-0', position: { x: -40, y: -30 }, width: 252, height: 242 }])
  expect(change).not.toHaveBeenCalled()
})

it('offers edge and corner controls, keyboard sizing and no edit on a stationary gesture', async () => {
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Node 0, / }))
  const group = await screen.findByRole('group', { name: 'Resize Node 0' })
  await waitFor(() => expect(group.querySelectorAll('.react-flow__resize-control')).toHaveLength(8))
  const corner = group.querySelector('.board-agent-resize-handle.bottom.right')!
  const view = document.defaultView!
  mouse(corner, 'mousedown', 212, 212)
  mouse(view, 'mouseup', 212, 212)
  expect(geometry).not.toHaveBeenCalled()
  act(() => { group.focus(); fireEvent.keyDown(group, { key: 'ArrowRight' }) })
  expect(geometry).toHaveBeenCalledWith([{ id: 'node-0', width: 220, height: 212 }])
  expect(container.querySelector('.react-flow__node[data-id="node-0"]')).toHaveStyle({ width: '220px' })
  expect(change).not.toHaveBeenCalled()
})
