import assert from 'node:assert/strict'
import { it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { deferred } from './helpers/agentChatF1.js'
import { environment, FixtureServer, manager, request } from './opencode-fixtures.js'

for (const operation of ['withLane', 'startTurn'] as const) {
  it(`restart close waits for the original ${operation} lane release without taking a second lease early`, async () => {
    const server = new FixtureServer(), raw = manager(server), coordination = nativeLanes()
    const writer = new SingleWriterSessionManager(raw, coordination, 'agent-1')
    const session = await writer.createSession({ request: request(), environment: environment() })
    const entered = deferred(), permit = deferred(), release = coordination.releaseLane.bind(coordination)
    let held = true, claims = 0
    coordination.releaseLane = async (...args) => {
      if (held) { entered.resolve(); await permit.promise }
      return release(...args)
    }
    const claim = coordination.claimLane.bind(coordination)
    coordination.claimLane = async (...args) => { claims++; return claim(...args) }
    let draining: Promise<unknown> | undefined, closing: Promise<unknown> | undefined
    try {
      if (operation === 'withLane') draining = writer.withLane(session, 'original-work', undefined, async () => undefined)
      else {
        const iterator = writer.startTurn(session, { prompt: 'retained prompt', clientCorrelationId: 'original-work' })[Symbol.asyncIterator]()
        assert.equal((await iterator.next()).done, false)
        draining = iterator.return!()
      }
      void draining.catch(() => undefined)
      await entered.promise
      const lane = await coordination.getLane('opencode', session.nativeSessionId)
      assert(lane?.leaseToken)
      const calls = [...server.calls], generation = server.generation, beforeClaims = claims
      let closeSettled = false
      let closeError: unknown
      closing = writer.closeForRestart(session).then(
        () => { closeSettled = true },
        error => { closeSettled = true; closeError = error; throw error },
      )
      void closing.catch(() => undefined)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(closeSettled, false, `an in-flight original release must remain visible to restart close: ${closeError instanceof DomainError ? closeError.code : String(closeError)}`)
      assert.equal(claims, beforeClaims, 'no competing claim before the original release completes')
      assert.deepEqual(await coordination.getLane('opencode', session.nativeSessionId), lane)
      assert.equal(server.disposals, 0)
      permit.resolve(); held = false
      await draining; await closing
      assert.equal(server.disposals, 1)
      assert.equal(server.generation, generation)
      assert.deepEqual(server.calls, calls, 'restart close must not cancel, respond, recreate or resubmit')
      const after = await coordination.getLane('opencode', session.nativeSessionId)
      assert.equal(after?.leaseToken, undefined)
      if (operation === 'startTurn') {
        const originalTurn = calls.find(call => call.path.includes('/prompt_async'))?.body?.messageID
        assert.equal(typeof originalTurn, 'string')
        assert.equal(after?.currentTurnOrMessageId, originalTurn)
        assert.equal(after?.correlationId, lane.correlationId)
        assert.equal(after?.observedStatus, 'disconnected', 'detachment must not invent native idle')
      }
    } finally {
      held = false; permit.resolve()
      await draining?.catch(() => undefined); await closing?.catch(() => undefined)
      await raw.dispose()
    }
  })
}

it('a rejected original lane release keeps restart close failed and cannot become a native closure receipt', async () => {
  const server = new FixtureServer(), raw = manager(server), coordination = nativeLanes()
  const writer = new SingleWriterSessionManager(raw, coordination, 'agent-1')
  const session = await writer.createSession({ request: request(), environment: environment() })
  const entered = deferred(), permit = deferred(), failure = new Error('Original lane release remains unconfirmed')
  coordination.releaseLane = async () => { entered.resolve(); await permit.promise; throw failure }
  const draining = writer.withLane(session, 'original-work', undefined, async () => undefined)
  const failedDrain = assert.rejects(draining, error => error === failure)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    const before = await coordination.getLane('opencode', session.nativeSessionId)
    closing = writer.closeForRestart(session)
    const failedClose = assert.rejects(closing, error => error === failure)
    void failedClose.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(server.disposals, 0)
    permit.resolve()
    await failedDrain; await failedClose
    assert.deepEqual(await coordination.getLane('opencode', session.nativeSessionId), before)
    assert(before?.leaseToken, 'failed persistence must leave the original lane ownership unresolved')
    assert.equal(server.disposals, 0)
    await assert.rejects(writer.closeForRestart(session), { code: 'SESSION_LANE_BUSY' })
    assert.equal(server.disposals, 0, 'a retry cannot bypass the still-owned lane')
  } finally {
    permit.resolve(); await draining.catch(() => undefined); await closing?.catch(() => undefined)
    await raw.dispose()
  }
})
