import assert from 'node:assert/strict'

import { describe, it } from 'vitest'

import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { reviewCoordination, reviewSession } from './pr17-agent2-fixtures.js'

describe('PR17 #6: targeted writer cancellation', () => {
  it('forwards current/stale targets exactly and preserves omitted-target behavior', async () => {
    const targets: (string | undefined)[] = []
    const manager = { harness: 'codex', cancel: async (session, signal, target) => {
      assert.deepEqual(session, reviewSession)
      assert.ok(signal instanceof AbortSignal)
      targets.push(target)
      return target === undefined || target === 'current-turn'
    } } as NativeHarnessSessionManager
    const writer = new SingleWriterSessionManager(manager, reviewCoordination().repository, 'reviewer')
    assert.equal(await writer.cancel(reviewSession, undefined, 'stale-turn'), false)
    assert.equal(await writer.cancel(reviewSession, undefined, 'current-turn'), true)
    assert.equal(await writer.cancel(reviewSession), true)
    assert.deepEqual(targets, ['stale-turn', 'current-turn', undefined])
  })

  it('retains each queued target through control serialization on an active lane', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const firstEntered = new Promise<void>((resolve) => { entered = resolve })
    const targets: (string | undefined)[] = []
    const manager = { harness: 'codex', cancel: async (_session, _signal, target) => {
      targets.push(target)
      if (targets.length === 1) { entered(); await blocked }
      return target === 'current-turn'
    } } as NativeHarnessSessionManager
    const writer = new SingleWriterSessionManager(manager, reviewCoordination().repository, 'reviewer')
    await writer.withLane(reviewSession, 'review-correlation', undefined, async () => {
      const first = writer.cancel(reviewSession, undefined, 'current-turn')
      await firstEntered
      const stale = writer.cancel(reviewSession, undefined, 'stale-turn')
      assert.deepEqual(targets, ['current-turn'])
      release()
      assert.deepEqual(await Promise.all([first, stale]), [true, false])
    })
    assert.deepEqual(targets, ['current-turn', 'stale-turn'])
  })
})
