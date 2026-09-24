import { useCallback, useEffect, useState } from 'react'
import { useGraphPresentation, useGraphPresentationStore } from '../graph/useGraphPresentation'
import { useRunGraphSelection } from './hooks'
import { selectGraphRun, selectGraphTopology } from './cache'
import {
  selectAttentionAnnouncement, selectAttentionNodes, selectExchangeOptions, selectFocusedExchange,
  type ExchangeView,
} from './exchangePresentation'
import type { RunGraphRecord } from './types'
import { Select } from '../../shared/ui/nocturne'

export function RunAttentionTools() {
  const run = useRunGraphSelection(selectGraphRun)
  const blockers = useRunGraphSelection(selectAttentionNodes) ?? []
  const topology = useRunGraphSelection(selectGraphTopology)
  const selected = useGraphPresentation((state) => state.selectedNodeIds.values().next().value as string | undefined)
  const edgeId = useGraphPresentation((state) => state.focusedEdgeId)
  const presentation = useGraphPresentationStore()
  return <section className="run-graph-attention-tools" aria-label="Run attention and navigation">
    <div><strong>Attention</strong><p>{run ? `${run.pendingInteractionCount} pending requests · ${run.unsettledReviewCount} unsettled reviews${run.cleanupPending ? ' · Cleanup pending' : ''}` : 'Attention unavailable'}</p></div>
    <Select className="run-graph-field" label="Inspect a node needing attention" value={selected ?? ''} options={[
      { value: '', label: blockers.length ? `${blockers.length} nodes to inspect` : 'No nodes listed in current attention facts' },
      ...(selected && !blockers.some((node) => node.id === selected) ? [{ value: selected, label: `Selected node: ${selected}` }] : []),
      ...blockers.map((node) => ({ value: node.id, label: node.label })),
    ]} onChange={(event) => {
      const id = event.target.value
      presentation.getState().setSelectedNodeIds(new Set(id ? [id] : []))
      presentation.getState().setFocusedEdgeId(undefined)
      presentation.getState().setFocusedExchangeKey(undefined)
    }} />
    <Select className="run-graph-field" label="Inspect a relationship" value={edgeId ?? ''} options={[
      { value: '', label: 'All immutable relationships' },
      ...(topology?.relationships.map((edge) => ({ value: edge.relationshipId, label: `${edge.kind} · ${edge.source} → ${edge.target} · ${edge.relationshipId}` })) ?? []),
    ]} onChange={(event) => {
      presentation.getState().setFocusedEdgeId(event.target.value || undefined)
      presentation.getState().setSelectedNodeIds(new Set())
      presentation.getState().setFocusedExchangeKey(undefined)
    }} />
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
    <Select className="run-graph-field" label="Inspect an exchange" value={selected ?? ''} options={[
      { value: '', label: views.length ? `${views.length} current exchange records` : 'No exchanges in this current selection' },
      ...(selected && !focused ? [{ value: selected, label: `Selected exchange unavailable: ${selected}` }] : []),
      ...views.map((item) => ({ value: item.key, label: `${item.title} · ${item.from} → ${item.to}` })),
    ]} onChange={(event) => presentation.getState().setFocusedExchangeKey(event.target.value || undefined)} />
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
