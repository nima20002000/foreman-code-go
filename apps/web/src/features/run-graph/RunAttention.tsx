import { useCallback, useEffect, useState } from 'react'
import { useGraphPresentation, useGraphPresentationStore } from '../graph/useGraphPresentation'
import { useRunGraphSelection } from './hooks'
import { selectGraphRun, selectGraphTopology } from './cache'
import {
  selectAttentionAnnouncement, selectAttentionNodes, selectExchangeOptions, selectFocusedExchange,
  type ExchangeView,
} from './exchangePresentation'
import type { RunGraphRecord } from './types'

export function RunAttentionTools() {
  const run = useRunGraphSelection(selectGraphRun)
  const blockers = useRunGraphSelection(selectAttentionNodes) ?? []
  const topology = useRunGraphSelection(selectGraphTopology)
  const selected = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const presentation = useGraphPresentationStore()
  return <section className="run-graph-attention-tools" aria-label="Run attention and navigation">
    <div><strong>Attention</strong><p>{run ? `${run.pendingInteractionCount} pending requests · ${run.unsettledReviewCount} unsettled reviews${run.cleanupPending ? ' · Cleanup pending' : ''}` : 'Attention unavailable'}</p></div>
    <label className="run-graph-field">Inspect a node needing attention
      <select value={selected ?? ''} onChange={(event) => {
        const id = event.target.value
        presentation.getState().setSelectedNodeIds(new Set(id ? [id] : []))
        presentation.getState().setFocusedEdgeId(undefined)
        presentation.getState().setFocusedExchangeKey(undefined)
      }}>
        <option value="">{blockers.length ? `${blockers.length} nodes to inspect` : 'No nodes listed in current attention facts'}</option>
        {selected && !blockers.some((node) => node.id === selected) ? <option value={selected}>Selected node: {selected}</option> : null}
        {blockers.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
      </select>
    </label>
    <label className="run-graph-field">Inspect a relationship
      <select value={edgeId ?? ''} onChange={(event) => {
        presentation.getState().setFocusedEdgeId(event.target.value || undefined)
        presentation.getState().setSelectedNodeIds(new Set())
        presentation.getState().setFocusedExchangeKey(undefined)
      }}>
        <option value="">All immutable relationships</option>
        {topology?.relationships.map((edge) => <option key={edge.relationshipId} value={edge.relationshipId}>
          {edge.kind} · {edge.source} → {edge.target} · {edge.relationshipId}
        </option>)}
      </select>
    </label>
  </section>
}

function ExchangeFacts({ view }: { view: ExchangeView }) {
  return <section className="run-graph-exchange" aria-label="Focused exchange facts">
    <h4>{view.title}</h4>
    <dl>{view.fields.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    <p className="run-graph-hint">Decision, review settlement, native delivery, and resumption are independent facts.</p>
  </section>
}

/** A single stable native control, keyed by exact entity kind/ID. Polls never reset selection or focus. */
export function RunExchangeInspector({ nodeId, relationshipId }: { nodeId?: string; relationshipId?: string }) {
  const selected = useGraphPresentation((state) => state.focusedExchangeKey)
  const presentation = useGraphPresentationStore()
  const views = useRunGraphSelection(useCallback((record: RunGraphRecord) => selectExchangeOptions(record, nodeId, relationshipId), [nodeId, relationshipId])) ?? []
  const focused = useRunGraphSelection(useCallback((record: RunGraphRecord) => selectFocusedExchange(record, selected, nodeId, relationshipId), [selected, nodeId, relationshipId]))
  return <section aria-label="Exchange inspection">
    <h3>Exchanges</h3>
    <label className="run-graph-field">Inspect an exchange
      <select value={selected ?? ''} onChange={(event) => presentation.getState().setFocusedExchangeKey(event.target.value || undefined)}>
        <option value="">{views.length ? `${views.length} current exchange records` : 'No exchanges in this current selection'}</option>
        {selected && !focused ? <option value={selected}>Selected exchange unavailable: {selected}</option> : null}
        {views.map((item) => <option key={item.key} value={item.key}>{item.title} · {item.from} → {item.to}</option>)}
      </select>
    </label>
    {focused ? <ExchangeFacts view={focused} /> : selected
      ? <p>The selected exchange is unavailable in this current window. Other requests and cleanup remain independent.</p>
      : <p className="run-graph-hint">Choose an exact request, review, or accepted input receipt. Relationship arrows show authority/dependency; request and response directions are listed separately.</p>}
  </section>
}

/** Only this aggregate region is live. Node actions, routine polls, and cues never announce themselves. */
export function RunAttentionAnnouncement() {
  const message = useRunGraphSelection(selectAttentionAnnouncement) ?? 'Loading confirmed facts.'
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(message), 250)
    return () => clearTimeout(timer)
  }, [message])
  return <p className="run-graph-sr-only" role="status" aria-live="polite" aria-atomic="true">{message === 'Run access unavailable.' ? message : announcement}</p>
}
