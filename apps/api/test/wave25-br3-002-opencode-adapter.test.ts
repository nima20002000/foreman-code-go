import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@graphql/contracts'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { OPENCODE_RECONCILIATION_EVENT, matchesOpenCodeHistorySource, readOpenCodeReconciliation } from '../src/modules/harnesses/opencodeReconciliation.js'
import { openCodeReviewTerminalOutcome } from '../src/modules/harnesses/opencodeReviewTerminal.js'
import { FixtureServer, manager, sessionFor } from './opencode-fixtures.js'
import { br3002Assistant, br3002Cases, br3002Notify, type Br3002Case } from './helpers/wave25Br3002Review.js'

/** Actual manager, rooted scanner, SSE decoder and marker cache. Only the external
 * provider HTTP/SSE port is deterministic; this is NOT live-provider qualification. */
async function observe(variant: Br3002Case, live: boolean) {
  const server = new FixtureServer(), native = manager(server)
  const signal = AbortSignal.timeout(10000)
  const events: NativeHarnessEvent[] = []
  try {
    const session = await sessionFor(native)
    const correlationId = `br3-002-${variant.name}`
    server.onPrompt = (sessionID) => {
      const message = br3002Assistant(server, correlationId, sessionID, variant)
      br3002Notify(server, message, live)
    }
    const generation = server.generation
    for await (const event of native.startTurn(session, { clientCorrelationId: correlationId, prompt: 'Review this exact request.' }, signal)) events.push(event)
    const history = await native.reconcile(session, correlationId, signal)
    const again = await native.reconcile(session, correlationId, signal)
    expect(server.generation).toBe(generation)
    expect(server.calls.filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
    expect(events.some((event) => /turn[./]completed/.test(event.type))).toBe(false)
    const liveAssistants = events.filter((event) => event.type === 'message.updated'
      && !event.connectionId?.startsWith('history-') && object(event.payload.info).role === 'assistant')
    expect(liveAssistants).toHaveLength(live ? 1 : 0)
    const markers = history.events.filter((event) => event.type === OPENCODE_RECONCILIATION_EVENT)
    expect(markers).toHaveLength(variant.marker ? 1 : 0)
    expect(again.events.filter((event) => event.type === OPENCODE_RECONCILIATION_EVENT)).toEqual(markers)
    if (!variant.marker) return { reviewOutcome: undefined, ordinaryOutcome: history.terminalResult?.outcome }
    const marker = markers[0]!
    const proof = readOpenCodeReconciliation(marker, { ownerAgentId: 'agent-1', nativeSessionId: session.nativeSessionId,
      providerVersion: session.providerVersion, correlationId, nativeTurnId: nativeMessageId(correlationId) })!
    expect(proof).toBeDefined()
    const raw = history.events.find((event) => event.connectionId === proof.historySource.connectionId
      && event.sequence === proof.historySource.sequence)!
    expect(raw).toBeDefined()
    expect(matchesOpenCodeHistorySource(proof, raw)).toBe(true)
    const before = structuredClone({ raw, marker })
    const reviewOutcome = openCodeReviewTerminalOutcome(raw.payload.info)
    expect(reviewOutcome).toBe(variant.reviewOutcome)
    // The generic manager result/marker is not globally redefined for reviews.
    expect(history.terminalResult?.outcome).toBe(variant.ordinaryOutcome)
    expect(proof.outcome).toBe(variant.ordinaryOutcome)
    expect({ raw, marker }).toEqual(before)
    expect(raw.sequence).toBe(0)
    expect(raw.connectionId).toMatch(/^history-/)
    expect(raw.payload.nativeEventId).toBe(proof.historySource.nativeEventId)
    expect(raw.connectionId).not.toBe(marker.connectionId)
    return { reviewOutcome, ordinaryOutcome: history.terminalResult?.outcome }
  } finally { await native.dispose() }
}

describe('BR3-002 actual OpenCode adapter terminal matrix', () => {
  for (const variant of br3002Cases) it(`${variant.name}: live+history equals lost-live history without changing ordinary results`, async () => {
    expect(await observe(variant, true)).toEqual(await observe(variant, false))
  }, 30000)
})

describe('BR3-002 review-only classification', () => {
  const complete = { id: 'msg_answer', sessionID: 'ses_review', parentID: 'msg_root', role: 'assistant', time: { completed: 12 } }
  it.each([
    ['stop', 'succeeded'], ['length', 'failed'], ['content-filter', 'failed'],
    ['tool-calls', undefined], ['unknown', undefined], ['error', undefined], ['new-finish', undefined],
  ])('classifies %s explicitly', (finish, expected) => {
    expect(openCodeReviewTerminalOutcome({ ...complete, finish })).toBe(expected)
  })
  it.each([undefined, null, '12', NaN, Infinity])('rejects incomplete/non-finite completion %s', (completed) => {
    expect(openCodeReviewTerminalOutcome({ ...complete, finish: 'stop', time: { completed } })).toBeUndefined()
  })
  it('does not accept summaries, non-assistants, text or a decision as terminal proof', () => {
    for (const value of [null, [], 'stop', { ...complete, finish: 'stop', summary: true },
      { ...complete, finish: 'stop', role: 'user' }, { decision: 'accepted', text: 'done' }]) {
      expect(openCodeReviewTerminalOutcome(value)).toBeUndefined()
    }
  })
  it('fails a completed assistant error even with stop, but withholds incomplete error settlement', () => {
    expect(openCodeReviewTerminalOutcome({ ...complete, finish: 'stop', error: { name: 'APIError' } })).toBe('failed')
    expect(openCodeReviewTerminalOutcome({ ...complete, time: {}, error: { name: 'APIError' } })).toBeUndefined()
  })
})
