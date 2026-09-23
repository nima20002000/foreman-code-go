import type { QueryClient } from '@tanstack/react-query'
import { RunCurrentResponseSchema } from '@graphql/contracts/run-current'
import {
  RUN_GRAPH_LIMITS, RunGraphScopeSchema, RunGraphSnapshotSchema, RunGraphErrorResponseSchema, sameGraphScope,
  type RunGraphScope,
} from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { sessionGeneration, sessionSignal, sessionIsSwitching, assertSession } from '../../shared/api/sessionBoundary'
import { keepLatestRunCurrent } from './legacyCurrent'
import { graphCachePrefix, graphCapabilityKey, graphRecordKey, shareGraphRecordOrSelection } from './cache'
import { negotiateGraphReader, runGraphClient, type RunGraphClient } from './client'
import { GraphProtocolError } from './errors'
import { acceptGraphSnapshot, graphNeedsPolling, reduceGraphPage, type AcceptedBatch } from './reducer'
import { createSerialLoop } from './serialLoop'
import type { AcceptedBatchListener, GraphTransportPhase, RunGraphRecord } from './types'

const ACTIVE_POLL_MS = 1000
const MAX_PAGES_PER_BURST = 4
const REQUEST_TIMEOUT_MS = 10_000
let nextEpoch = 0

type Owner = {
  scope: RunGraphScope
  epoch: number
  references: number
  listeners: Set<AcceptedBatchListener>
  dispose: () => void
  retry: () => void
}
type SessionOwners = { generation: number; owners: Map<string, Owner>; closed: boolean }
const sessions = new WeakMap<QueryClient, SessionOwners>()

function ownerKey(scope: RunGraphScope): string { return JSON.stringify([scope.workspaceId, scope.runId]) }
function matchingRecords(client: QueryClient, generation: number, workspaceId?: string) {
  return client.getQueryCache().findAll({ queryKey: [...graphCachePrefix, generation] }).filter((query) =>
    query.queryKey.length === 8 && (workspaceId === undefined || query.queryKey[3] === workspaceId))
}

/** Clears facts before removal so mounted cache-only observers also lose protected data. */
function revoke(client: QueryClient, session: SessionOwners, workspaceId?: string): void {
  for (const [key, owner] of session.owners) {
    if (workspaceId !== undefined && owner.scope.workspaceId !== workspaceId) continue
    owner.dispose()
    session.owners.delete(key)
  }
  for (const query of matchingRecords(client, session.generation, workspaceId)) {
    void client.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined)
    const old = query.state.data as RunGraphRecord | undefined
    if (old?.scope) client.setQueryData<RunGraphRecord>(query.queryKey, {
      kind: 'run-graph-cache', scope: old.scope, epoch: ++nextEpoch, transport: { phase: 'denied', reason: 'GRAPH_READ_ACCESS_DENIED' },
    })
    // Keep active tombstones until their observers leave; removing them can leave a stale observer result.
    if (query.getObserversCount() === 0) client.removeQueries({ queryKey: query.queryKey, exact: true })
  }
  client.removeQueries({ queryKey: graphCapabilityKey(session.generation), exact: true })
}

function sessionOwners(client: QueryClient): SessionOwners {
  const generation = sessionGeneration()
  const previous = sessions.get(client)
  if (previous?.generation === generation) return previous
  if (previous) { previous.closed = true; revoke(client, previous) }
  const current: SessionOwners = { generation, owners: new Map(), closed: false }
  sessions.set(client, current)
  sessionSignal().addEventListener('abort', () => {
    current.closed = true
    revoke(client, current)
  }, { once: true })
  return current
}

/** Explicit shell hook as well as the existing sessionSignal abort integration. */
export function revokeRunGraphWorkspace(client: QueryClient, workspaceId: string): void {
  const session = sessions.get(client)
  if (session) revoke(client, session, workspaceId)
}

export function clearRunGraphAccess(client: QueryClient): void {
  const session = sessions.get(client)
  if (session) { session.closed = true; revoke(client, session) }
}

function errorCode(error: unknown): string {
  if (error instanceof GraphProtocolError) return error.code
  if (ApiError.is(error)) {
    if (['NETWORK_ERROR', 'INVALID_RESPONSE', 'INVALID_REQUEST', 'HTTP_ERROR'].includes(error.code)) return error.code
    return RunGraphErrorResponseSchema.safeParse({ error: { code: error.code, message: 'Graph synchronization failed' } }).success
      ? error.code : 'GRAPH_SYNC_UNAVAILABLE'
  }
  if (error instanceof Error && /^GRAPH_[A-Z_]+$/.test(error.message)) return error.message
  return 'GRAPH_SYNC_UNAVAILABLE'
}

function createOwner(client: QueryClient, session: SessionOwners, scope: RunGraphScope, api: RunGraphClient): Owner {
  let epoch = ++nextEpoch
  const key = graphRecordKey(scope, session.generation)
  let disposed = false
  let catchingUp = true
  let needSnapshot = false
  let initialized = false
  let reader: 'graph' | 'legacy' | undefined
  let burst = 0
  let catchupBatches = 0
  let gaps = 0
  let resets = 0
  const listeners = new Set<AcceptedBatchListener>()
  const current = () => client.getQueryData<RunGraphRecord>(key)
  const setPhase = (phase: GraphTransportPhase, reason?: string) => {
    if (disposed || session.closed) return
    client.setQueryData<RunGraphRecord>(key, (old) => ({ kind: 'run-graph-cache', scope, epoch, facts: old?.facts,
      transport: { phase, reason, confirmedAt: old?.transport?.confirmedAt } }))
  }
  const valid = (signal: AbortSignal) => {
    signal.throwIfAborted()
    assertSession(session.generation)
    if (disposed || session.closed || sessionIsSwitching()) throw new DOMException('Obsolete graph view', 'AbortError')
  }
  const reset = (reason: string): number | false => {
    epoch = ++nextEpoch
    owner.epoch = epoch
    catchingUp = true
    needSnapshot = true
    catchupBatches = 0
    if (++resets > 3) { setPhase('error', 'GRAPH_RESET_LIMIT'); return false }
    setPhase('resetting', reason)
    return 0
  }
  const owner: Owner = { scope, epoch, references: 0, listeners,
    retry: () => {
      epoch = ++nextEpoch
      owner.epoch = epoch
      setPhase('catching-up')
      catchingUp = true
      reader = undefined
      void client.invalidateQueries({ queryKey: graphCapabilityKey(session.generation), exact: true }).then(() => {
        if (!disposed) loop.wake()
      }).catch(() => undefined)
    }, dispose: () => {
    if (disposed) return
    disposed = true
    loop.dispose()
    listeners.clear()
    void client.cancelQueries({ queryKey: key, exact: true }).catch(() => undefined)
  } }
  const loop = createSerialLoop(async (signal) => {
    let accepted: AcceptedBatch[] = []
    let cueMode: 'catchup' | 'live' = 'catchup'
    let more = false
    let tookSnapshot = false
    try {
      valid(signal)
      if (!initialized) {
        const cached = current()
        // A restored cursor alone, malformed record or old session is not a recoverable fact base.
        if (cached?.facts?.reader === 'graph' && !RunGraphSnapshotSchema.safeParse(cached.facts.snapshot).success
          || cached?.facts?.reader === 'legacy' && !RunCurrentResponseSchema.safeParse(cached.facts.response).success) {
          client.setQueryData<RunGraphRecord>(key, { kind: 'run-graph-cache', scope, epoch, transport: { phase: 'loading' } })
        }
        setPhase(current()?.facts ? 'catching-up' : 'loading')
        initialized = true
      }
      if (!reader) {
        const capabilities = await client.fetchQuery({
          queryKey: graphCapabilityKey(session.generation), staleTime: 30_000, retry: false, networkMode: 'always',
          queryFn: ({ signal: querySignal }) => api.capabilities(AbortSignal.any([signal, querySignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])),
        })
        valid(signal)
        reader = negotiateGraphReader(capabilities, scope)
      }
      const result = await client.fetchQuery<RunGraphRecord>({
        queryKey: key, staleTime: 0, retry: false, networkMode: 'always', structuralSharing: shareGraphRecordOrSelection,
        queryFn: async ({ signal: querySignal }) => {
          const requestSignal = AbortSignal.any([signal, querySignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          const old = current()
          if (reader === 'legacy') {
            const parsed = RunCurrentResponseSchema.safeParse(await api.legacy(scope, requestSignal))
            if (!parsed.success) throw new GraphProtocolError('GRAPH_INVALID_LEGACY_RESPONSE')
            const response = parsed.data
            valid(requestSignal)
            const run = response.run
            if (run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId || run.id !== scope.runId
              || run.workflowVersionId !== scope.workflowVersionId || scope.executionSemanticsVersion !== 1) throw new GraphProtocolError('GRAPH_SCOPE_MISMATCH')
            const latest = current()
            const previous = latest?.facts?.reader === 'legacy' ? latest.facts.response : undefined
            return { kind: 'run-graph-cache', scope, epoch, facts: { reader: 'legacy', response: keepLatestRunCurrent(previous, response) },
              transport: { phase: 'live', confirmedAt: Date.now() } }
          }
          const previous = old?.facts?.reader === 'graph' ? old.facts.snapshot : undefined
          if (!previous || needSnapshot) {
            const input = await api.snapshot(scope, requestSignal)
            valid(requestSignal)
            const latest = current()
            const confirmed = latest?.facts?.reader === 'graph' ? latest.facts.snapshot : previous
            const snapshot = acceptGraphSnapshot(scope, input, confirmed)
            tookSnapshot = true
            return { kind: 'run-graph-cache', scope, epoch, facts: { reader: 'graph', snapshot },
              transport: { phase: 'catching-up', confirmedAt: Date.now() } }
          }
          const input = await api.events(scope, previous.asOfSequence, requestSignal)
          valid(requestSignal)
          // Never apply a delayed read over a newer accepted Stop/terminal/current snapshot.
          const latest = current()
          const confirmed = latest?.facts?.reader === 'graph' ? latest.facts.snapshot : undefined
          if (!confirmed) throw new GraphProtocolError('GRAPH_STATE_LOST')
          const reduced = reduceGraphPage(confirmed, input)
          if (reduced.kind === 'reset') throw new GraphProtocolError(`GRAPH_RESET_${reduced.reset!.reason.toUpperCase()}`)
          if (reduced.kind === 'gap' || reduced.kind === 'duplicate' && reduced.hasMore) throw new GraphProtocolError('GRAPH_GAP')
          more = reduced.hasMore
          const wasDelayed = !old?.transport.confirmedAt || Date.now() - old.transport.confirmedAt > 3 * ACTIVE_POLL_MS
          cueMode = catchingUp || more || wasDelayed ? 'catchup' : 'live'
          accepted = reduced.accepted
          return { kind: 'run-graph-cache', scope, epoch, facts: { reader: 'graph', snapshot: reduced.snapshot },
            transport: { phase: more ? 'catching-up' : 'live', confirmedAt: Date.now() } }
        },
      })
      valid(signal)
      const committed = current()
      if (result.epoch !== epoch || committed?.epoch !== epoch) return false
      if (result.facts?.reader === 'graph' && committed.facts?.reader === 'graph'
        && result.facts.snapshot.asOfSequence !== committed.facts.snapshot.asOfSequence) {
        catchingUp = true
        return ACTIVE_POLL_MS
      }
      if (tookSnapshot) { needSnapshot = false; catchingUp = true; return 0 }
      if (result.facts?.reader === 'legacy') {
        // Explicit compatibility policy: poll current facts only while viewed,
        // including clean terminal Runs. Settlement is unconfirmed; outcome or
        // cleanupPending=false cannot certify all native/review obligations.
        return ACTIVE_POLL_MS
      }
      // Only after fetchQuery has atomically published the complete record and cursor.
      for (const batch of accepted) {
        const cue = Object.freeze({ scope: Object.freeze({ ...scope }), epoch,
          batchId: batch.batchId, sequence: batch.sequence,
          eventIds: Object.freeze([...batch.eventIds]), mode: cueMode })
        for (const listener of [...listeners]) {
          if (disposed || session.closed) return false
          try { listener(cue) } catch { /* Disposable effects cannot fail or roll back fact acceptance. */ }
        }
      }
      if (cueMode === 'catchup') catchupBatches += accepted.length
      if (more && catchupBatches >= RUN_GRAPH_LIMITS.catchupBatches) return reset('GRAPH_CATCHUP_LIMIT')
      if (more) { catchingUp = true; return ++burst < MAX_PAGES_PER_BURST ? 0 : (burst = 0, ACTIVE_POLL_MS) }
      catchingUp = false
      catchupBatches = 0
      burst = 0
      gaps = 0
      resets = 0
      return result.facts?.reader === 'graph' && graphNeedsPolling(result.facts.snapshot) ? ACTIVE_POLL_MS : false
    } catch (error) {
      if (disposed || session.closed || signal.aborted || sessionGeneration() !== session.generation) return false
      catchingUp = true
      const code = errorCode(error)
      if (ApiError.is(error) && (error.status === 401 || error.status === 403 || error.code === 'GRAPH_READ_ACCESS_DENIED')) {
        if (error.status === 401) session.closed = true
        revoke(client, session, error.status === 401 ? undefined : scope.workspaceId)
        return false
      }
      if (code === 'GRAPH_GAP') {
        catchingUp = true
        if (++gaps > 1) return reset('GRAPH_GAP')
        setPhase('catching-up', code)
        return ACTIVE_POLL_MS // Retry from the last confirmed cursor, not the returned head.
      }
      if (code.startsWith('GRAPH_RESET_') && code !== 'GRAPH_RESET_SCHEMA_CHANGED') return reset(code)
      if (code === 'GRAPH_INVALID_CURSOR') return reset(code)
      if (error instanceof GraphProtocolError || code.startsWith('GRAPH_') && code !== 'GRAPH_SYNC_UNAVAILABLE'
        || ApiError.is(error) && (error.status >= 400 && error.status < 500 || code === 'INVALID_RESPONSE')) {
        setPhase('error', code)
        return false
      }
      catchingUp = true
      setPhase('stale', code)
      return ACTIVE_POLL_MS
    }
  }, () => setPhase('error', 'GRAPH_SYNC_UNAVAILABLE'))
  return owner
}

/** The only acquisition point. Hundreds of observers still acquire no timers or requests. */
export function retainRunGraphSync(client: QueryClient, input: RunGraphScope, api: RunGraphClient = runGraphClient) {
  const scope = RunGraphScopeSchema.parse(input)
  const session = sessionOwners(client)
  if (session.closed || sessionIsSwitching()) throw new GraphProtocolError('GRAPH_READ_ACCESS_DENIED')
  const key = ownerKey(scope)
  let owner = session.owners.get(key)
  if (owner && !sameGraphScope(owner.scope, scope)) throw new GraphProtocolError('GRAPH_SCOPE_MISMATCH')
  if (!owner) { owner = createOwner(client, session, scope, api); session.owners.set(key, owner) }
  const held = owner
  ++held.references
  let released = false
  const attached = new Set<AcceptedBatchListener>()
  return {
    get epoch() { return held.epoch },
    retry: () => { if (!released) held.retry() },
    subscribe(listener: AcceptedBatchListener) {
      if (released) return () => undefined
      const subscription: AcceptedBatchListener = (cue) => listener(cue)
      held.listeners.add(subscription)
      attached.add(subscription)
      return () => { held.listeners.delete(subscription); attached.delete(subscription) }
    },
    release() {
      if (released) return
      released = true
      for (const listener of attached) held.listeners.delete(listener)
      attached.clear()
      if (--held.references === 0) {
        held.dispose()
        if (session.owners.get(key) === held) session.owners.delete(key)
      }
    },
  }
}
