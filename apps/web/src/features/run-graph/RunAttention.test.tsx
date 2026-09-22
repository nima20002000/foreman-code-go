import { StrictMode, useEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphPresentationProvider } from '../graph/GraphPresentation'
import { useGraphPresentation, useGraphPresentationStore } from '../graph/useGraphPresentation'
import type { GraphPresentationStore } from '../graph/presentationStore'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { RunGraphContext } from './context'
import { graphRecordKey } from './cache'
import { RunAttentionAnnouncement, RunAttentionTools, RunExchangeInspector } from './RunAttention'
import { RunVisualEffects } from './RunVisualEffects'
import { addVisualApproval, addVisualReceipt, makeVisualFixture, nextVisualFixture, visualSignal, type VisualFixtureRecord } from './fixtures/visualFixture'
import { RunGraphProfileFixture } from './fixtures/RunGraphProfileFixture'
import type { AcceptedBatchListener } from './types'

const clients: QueryClient[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function Capture({ ready }: { ready: (store: GraphPresentationStore) => void }) {
  const store = useGraphPresentationStore()
  useEffect(() => ready(store), [ready, store])
  return null
}
function SelectedInspector() {
  const nodeId = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const relationshipId = useGraphPresentation((state) => state.focusedEdgeId)
  return <RunExchangeInspector nodeId={nodeId} relationshipId={relationshipId} />
}
function EffectHost() {
  const root = useRef<HTMLDivElement>(null)
  return <div ref={root}><RunVisualEffects root={root} /><div className="run-graph-canvas">
    <svg><path data-run-relationship="execution-edge-1" d="M0 0L100 100" /><path data-run-relationship="execution-edge-2" d="M0 0L200 100" /></svg>
  </div></div>
}
function setup(record = makeVisualFixture()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client)
  const generation = sessionGeneration()
  const key = graphRecordKey(record.scope, generation)
  client.setQueryData(key, record)
  const listeners = new Set<AcceptedBatchListener>()
  const value = { scope: record.scope, generation, retry: vi.fn(), subscribe: (listener: AcceptedBatchListener) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  let store: GraphPresentationStore | undefined
  const mounted = render(<QueryClientProvider client={client}><RunGraphContext.Provider value={value}><GraphPresentationProvider>
    <Capture ready={(current) => { store = current }} /><EffectHost />
    <RunAttentionTools /><SelectedInspector /><RunAttentionAnnouncement />
    <form aria-label="Existing unfinished form"><label>Unsubmitted note<input defaultValue="unsent draft" /></label></form>
  </GraphPresentationProvider></RunGraphContext.Provider></QueryClientProvider>)
  return { ...mounted, client, listeners, store: () => store!, publish: (next: VisualFixtureRecord, accepted = false) => {
    client.setQueryData(key, next)
    if (accepted) for (const listener of listeners) listener(visualSignal(next))
  } }
}
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function installMotion() {
  let reduced = false
  const changes = new Set<() => void>()
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, listener: () => void) => changes.add(listener), removeEventListener: (_type: string, listener: () => void) => changes.delete(listener) }))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300, toJSON: () => ({}) })
  return { changes, reduce: () => { reduced = true; for (const listener of changes) listener() } }
}

describe('Run attention controls (DOM units, not browser/performance qualification)', () => {
  it('keeps the isolated profile Query facts through StrictMode cleanup and receipt timers', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    render(<StrictMode><RunGraphProfileFixture count={100} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Publish five receipts' }))
    await flush(100)
    expect(screen.getByText('Synchronized')).toBeDefined()
    expect(screen.getByRole('option', { name: /Accepted input 1 · node-0 → node-1/ })).toBeDefined()
  })
  it('preserves exact exchange selection, keyboard focus, and unfinished form values through updates', async () => {
    const record = addVisualApproval(addVisualApproval(makeVisualFixture(), 1, 'one'), 1, 'two')
    const f = setup(record)
    const select = screen.getByRole('combobox', { name: 'Inspect an exchange' }) as HTMLSelectElement
    select.focus(); fireEvent.change(select, { target: { value: 'interaction:request-one' } })
    const current = nextVisualFixture(record)
    Object.assign(current.facts.snapshot.state.interactions[0]!, { revision: '2', status: 'decided', decision: 'approve_once', selectedOptionId: 'approve' })
    current.facts.snapshot.state.run.pendingInteractionCount = 1
    act(() => f.publish(current)); await flush()
    expect(document.activeElement).toBe(select); expect(select.value).toBe('interaction:request-one')
    expect(within(screen.getByRole('region', { name: 'Focused exchange facts' })).getByText('Approve once')).toBeDefined()
    expect(screen.getByRole('option', { name: /Approval request-two/ })).toBeDefined()
    const note = screen.getByRole('textbox', { name: 'Unsubmitted note' }) as HTMLInputElement
    note.focus(); fireEvent.change(note, { target: { value: 'keep this unsent text' } })
    act(() => f.publish({ ...current, transport: { phase: 'stale' } })); await flush()
    expect(document.activeElement).toBe(note); expect(note.value).toBe('keep this unsent text'); expect(select.value).toBe('interaction:request-one')
  })
  it('lets keyboard/touch native controls reach offscreen blockers and filters by exact relationship identity', async () => {
    const record = addVisualApproval(addVisualApproval(makeVisualFixture(), 1), 2)
    const f = setup(record)
    const relationships = screen.getByRole('combobox', { name: 'Inspect a relationship' })
    expect(relationships.tagName).toBe('SELECT')
    fireEvent.change(relationships, { target: { value: 'approval-edge-2' } }); await flush()
    expect(screen.queryByRole('option', { name: /Approval request-1/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Approval request-2/ })).toBeDefined()
    const nodes = screen.getByRole('combobox', { name: 'Inspect a node needing attention' })
    fireEvent.change(nodes, { target: { value: 'node-1' } }); await flush()
    expect(f.store().getState().selectedNodeIds.has('node-1')).toBe(true)
    expect(f.store().getState().focusedEdgeId).toBeUndefined()
    expect(screen.getByRole('option', { name: /Approval request-1/ })).toBeDefined()
  })
  it('retirement keeps the focused control and does not clear another request', async () => {
    const record = addVisualApproval(addVisualApproval(makeVisualFixture(), 1, 'one'), 1, 'two'); const f = setup(record)
    const select = screen.getByRole('combobox', { name: 'Inspect an exchange' }) as HTMLSelectElement
    select.focus(); fireEvent.change(select, { target: { value: 'interaction:request-one' } })
    const current = nextVisualFixture(record); current.facts.snapshot.state.interactions.shift()
    act(() => f.publish(current)); await flush()
    expect(document.activeElement).toBe(select); expect(select.value).toBe('interaction:request-one')
    expect(screen.getByText(/selected exchange is unavailable/)).toBeDefined()
    expect(screen.getByRole('option', { name: /Approval request-two/ })).toBeDefined()
  })
  it('uses one calm aggregate live region; routine tool updates do not change its message', async () => {
    const record = makeVisualFixture(); const f = setup(record)
    await flush(250)
    const regions = screen.getAllByRole('status'); expect(regions).toHaveLength(1)
    const message = regions[0]!.textContent
    const current = nextVisualFixture(record)
    current.facts.snapshot.state.nodes[1]!.activity = { workflowNodeId: 'node-1', status: 'unknown' }
    act(() => f.publish(current)); await flush(250)
    expect(regions[0]!.textContent).toBe(message)
  })
  it('starts effects only after accepted notification, cancels on reduced motion, and tears down subscriptions', async () => {
    const media = installMotion(); const before = makeVisualFixture(); const f = setup(before)
    const current = addVisualReceipt(before, 1)
    act(() => f.publish(current)); await flush(20)
    expect(f.store().getState().exchangeCues).toHaveLength(0)
    act(() => { for (const listener of f.listeners) listener(visualSignal(current)) }); await flush(50)
    expect(f.store().getState().exchangeCues).toHaveLength(1)
    act(() => media.reduce()); expect(f.store().getState().exchangeCues).toHaveLength(0)
    f.unmount(); expect(media.changes.size).toBe(0); expect(f.listeners.size).toBe(0)
    expect(f.store().getState().exchangeCues).toHaveLength(0)
  })
  it('a newer Stop cancels a pending cue before any animation can start', async () => {
    installMotion(); const before = makeVisualFixture(); const f = setup(before)
    const current = addVisualReceipt(before, 1)
    act(() => f.publish(current, true))
    const stopped = nextVisualFixture(current); stopped.facts.snapshot.state.run.stopRequested = true
    act(() => f.publish(stopped, true)); await flush(100)
    expect(f.store().getState().exchangeCues).toHaveLength(0)
  })
})
