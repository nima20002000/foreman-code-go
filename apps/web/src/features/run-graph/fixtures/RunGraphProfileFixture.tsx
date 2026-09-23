import { Profiler, useEffect, useState, type ProfilerOnRenderCallback } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RunGraphSnapshotSchema } from '@graphql/contracts/wave25'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { Button } from '../../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../../graph/GraphPresentation'
import { RunGraphContent } from '../RunGraphView'
import { RunGraphContext } from '../context'
import { graphRecordKey } from '../cache'
import type { AcceptedBatchCue, AcceptedBatchListener } from '../types'
import { addVisualApproval, addVisualReceipt, makeVisualFixture, nextVisualFixture, visualSignal, type VisualFixtureRecord } from './visualFixture'

/** Manual qualification harness using the ACTUAL renderer. Intentionally not registered in a product route. */
function ProfileFixture({ count, onRender }: { count: 100 | 300 | 500; onRender: ProfilerOnRenderCallback }) {
  const [harness] = useState(() => {
    const initial = addVisualApproval(addVisualApproval(makeVisualFixture(count), 2, 'one'), 2, 'two')
    RunGraphSnapshotSchema.parse(initial.facts.snapshot)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const generation = sessionGeneration()
    const key = graphRecordKey(initial.scope, generation)
    client.setQueryData(key, initial)
    const listeners = new Set<AcceptedBatchListener>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const context = { scope: initial.scope, generation, retry: () => undefined,
      subscribe: (listener: AcceptedBatchListener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const read = () => client.getQueryData<VisualFixtureRecord>(key)!
    const publish = (record: VisualFixtureRecord, mode: AcceptedBatchCue['mode']) => {
      const next = { ...record, transport: { ...record.transport, confirmedAt: Date.now() } }
      RunGraphSnapshotSchema.parse(next.facts.snapshot)
      client.setQueryData(key, next)
      for (const listener of listeners) listener(visualSignal(next, mode))
    }
    return { client, context, timers, read, publish }
  })
  useEffect(() => () => { for (const timer of harness.timers) clearTimeout(timer) }, [harness])
  const burst = () => {
    for (let index = 1; index <= 5; ++index) {
      const timer = setTimeout(() => {
        harness.timers.delete(timer)
        const current = harness.read()
        if (!current.facts.snapshot.state.inputBindings.some((item) => item.bindingId === `binding-${index}`)) harness.publish(addVisualReceipt(current, index), 'live')
      }, (index - 1) * 20)
      harness.timers.add(timer)
    }
  }
  return <QueryClientProvider client={harness.client}><RunGraphContext.Provider value={harness.context}><GraphPresentationProvider>
    <div className="n-theme">
      <p>Synthetic {count}-node renderer fixture. No network, native sessions, or Run admission.</p>
      <div className="n-actions">
        <Button onClick={burst}>Publish five receipts</Button>
        <Button onClick={() => { const next = nextVisualFixture(harness.read()); next.facts.snapshot.state.run.stopRequested = true; harness.publish(next, 'live') }}>Publish Stop</Button>
        <Button onClick={() => harness.publish({ ...harness.read(), transport: { phase: 'stale' } }, 'catchup')}>Mark telemetry stale</Button>
        <Button onClick={() => { const next = nextVisualFixture(harness.read()); next.transport.phase = 'live'; harness.publish(next, 'catchup') }}>Catch up without cues</Button>
      </div>
    </div>
    <Profiler id={`run-graph-${count}`} onRender={onRender}><RunGraphContent /></Profiler>
  </GraphPresentationProvider></RunGraphContext.Provider></QueryClientProvider>
}

export function RunGraphProfileFixture({ count = 300, onRender = () => undefined }: { count?: 100 | 300 | 500; onRender?: ProfilerOnRenderCallback }) {
  return <ProfileFixture key={count} count={count} onRender={onRender} />
}
