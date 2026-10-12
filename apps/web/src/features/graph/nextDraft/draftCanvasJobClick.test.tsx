import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { definition } from '../../jobs/fixtures'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { attachJob } from './model'
import { nextDraftKey } from './state'

// Real React Flow node-wrapper bubbling: DraftCanvas is not stubbed.
const key = nextDraftKey('workspace', 'workflow')
const context = fixture()
const graph = attachJob(context.draft.graph, { ...definition, workspaceId: 'workspace' }, 'job-node')
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context)) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); useGraphDraftStore.getState().clearAllDrafts() })

function mount() {
  const change = vi.fn()
  render(<GraphPresentationProvider><DraftCanvas draftKey={key} graph={graph} agents={context.agents.map((item) => item.agent)} kind="execution"
    change={change} geometry={vi.fn()} pending={vi.fn()} report={vi.fn()} /></GraphPresentationProvider>)
  const job = () => screen.getByRole('button', { name: new RegExp(`${definition.name}, job`) })
  const agent = (index: number) => screen.getByRole('button', { name: new RegExp(`^Node ${index}, `) })
  const edges = () => change.mock.calls.map(([update]) => update(graph).edges.at(-1)).map((edge: { source: string; target: string }) => `${edge.source}>${edge.target}`)
  return { change, job, agent, edges }
}

it('connects Job to Agent with one selection per click', async () => {
  const { job, agent, edges, change } = mount()
  fireEvent.click(job())
  fireEvent.click(agent(1))
  expect(change).toHaveBeenCalledOnce()
  expect(edges()).toEqual(['job-node>node-1'])
})

it('connects Agent to Job and does not rearm the Job', async () => {
  const { job, agent, edges, change } = mount()
  fireEvent.click(agent(0))
  fireEvent.click(job())
  expect(change).toHaveBeenCalledOnce()
  expect(edges()).toEqual(['node-0>job-node'])
  fireEvent.click(agent(1))
  expect(change).toHaveBeenCalledOnce()
})

it('shows the CI server on a saved workflow Board without adding it to the graph', async () => {
  const { change } = mount()
  const server = await screen.findByRole('button', { name: /^CI server, Idle/ })
  fireEvent.click(server)
  const dialog = await screen.findByRole('dialog', { name: 'CI server' })
  expect(dialog).toHaveTextContent('No Run selected')
  expect(change).not.toHaveBeenCalled()
})
