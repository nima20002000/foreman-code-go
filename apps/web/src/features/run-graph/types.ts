import type { RunCurrentResponse } from '@graphql/contracts/run-current'
import type { RunGraphScope, RunGraphSnapshot } from '@graphql/contracts/wave25'

export type GraphTransportPhase = 'loading' | 'catching-up' | 'live' | 'stale' | 'resetting' | 'error' | 'denied'
export type GraphTransport = {
  phase: GraphTransportPhase
  confirmedAt?: number
  reason?: string
}

/** Query owns this complete record. No cursor is persisted separately from its facts. */
export type RunGraphRecord = {
  kind: 'run-graph-cache'
  scope: RunGraphScope
  epoch: number
  transport: GraphTransport
  facts?: { reader: 'graph'; snapshot: RunGraphSnapshot } | { reader: 'legacy'; response: RunCurrentResponse }
}

/** Deliberately contains no writable cache, event payloads, or business-state references. */
export type AcceptedBatchCue = Readonly<{
  scope: Readonly<RunGraphScope>
  epoch: number
  batchId: string
  sequence: string
  eventIds: readonly string[]
  mode: 'catchup' | 'live'
}>
export type AcceptedBatchListener = (cue: AcceptedBatchCue) => void
