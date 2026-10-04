import { strict as assert } from 'node:assert'

import { describe, it } from 'vitest'
import type { OpenCodeHarnessConfiguration } from '@foreman-code/contracts'

import { OpenCodeNativeAutoReplies, usesOpenCodeNativeAuto } from '../src/modules/harnesses/opencodeNativeAuto.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const request = (id = 'permission-1', sessionID = 'session-1') => ({ id, sessionID })
const signal = () => new AbortController().signal
const errorCode = (code: string) => (error: unknown) => {
  assert.equal((error as { result?: { error?: { code?: string } } }).result?.error?.code, code)
  return true
}

describe('OpenCode native automatic permission replies', () => {
  it('recognizes both explicit native-auto representations without enabling routed defaults', () => {
    const configuration = (autoApprove: boolean, permissionHandling?: 'native_auto' | 'graphql_routed') => ({
      autoApprove, ...(permissionHandling ? { advanced: { permissionHandling } } : {}),
    }) as OpenCodeHarnessConfiguration
    assert.equal(usesOpenCodeNativeAuto(configuration(false)), false)
    assert.equal(usesOpenCodeNativeAuto(configuration(false, 'graphql_routed')), false)
    assert.equal(usesOpenCodeNativeAuto(configuration(true)), true)
    assert.equal(usesOpenCodeNativeAuto(configuration(true, 'native_auto')), true)
  })

  it('answers an actual ask once, not once per repeated pending snapshot', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    const sent: string[] = []
    const read = async () => [request()]
    const reply = async ({ id }: { id: string }) => { sent.push(id) }
    assert.deepEqual(await replies.consume(read, reply, signal()), [request()])
    assert.deepEqual(await replies.consume(read, reply, signal()), [])
    assert.deepEqual(sent, ['permission-1'])
  })

  it('serializes authoritative reads as well as mutations across concurrent observers', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    const entered = deferred(), release = deferred()
    let reads = 0, sends = 0
    const read = async () => { reads++; return [request()] }
    const reply = async () => { sends++; entered.resolve(); await release.promise }
    const first = replies.consume(read, reply, signal())
    await entered.promise
    const second = replies.consume(read, reply, signal())
    await Promise.resolve()
    assert.equal(reads, 1)
    release.resolve()
    await Promise.all([first, second])
    assert.equal(reads, 2)
    assert.equal(sends, 1)
  })

  it('does not mistake an HTTP reply acknowledgement for a drained native request', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    await replies.consume(async () => [request()], async () => {}, signal())
    assert.equal(replies.hasPending, true)
    await replies.consume(async () => [], async () => { assert.fail('No native ask exists') }, signal())
    assert.equal(replies.hasPending, false)
  })

  it('does not invent requests for native allow or deny decisions', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    assert.deepEqual(await replies.consume(async () => [], async () => { assert.fail('No native ask exists') }, signal()), [])
  })

  it('remembers unconfirmed delivery and never automatically retries it', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    let sent = 0
    const reply = async () => { sent++; throw new Error('secret-native-response-value') }
    await assert.rejects(replies.consume(async () => [request()], reply, signal()), (error: unknown) => {
      errorCode('OPENCODE_NATIVE_AUTO_REPLY_UNCONFIRMED')(error)
      assert.ok(!String(error).includes('secret-native-response-value'))
      return true
    })
    await assert.rejects(replies.consume(async () => [request()], reply, signal()), errorCode('OPENCODE_NATIVE_AUTO_REPLY_UNCONFIRMED'))
    assert.equal(sent, 1)
  })

  it('rejects a request ID rebound to a different native owner', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    let sent = 0
    const reply = async () => { sent++ }
    await replies.consume(async () => [request()], reply, signal())
    await assert.rejects(replies.consume(async () => [request('permission-1', 'other-session')], reply, signal()), errorCode('OPENCODE_NATIVE_AUTO_IDENTITY_CONFLICT'))
    assert.equal(sent, 1)
  })

  it('cancels queued work before even reading permission state', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    replies.stop()
    await assert.rejects(replies.consume(async () => { assert.fail('Stopped read'); return [] }, async () => { assert.fail('Stopped reply') }, signal()))
  })

  it('checks cancellation again after a noncooperative native read finishes', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    const entered = deferred(), release = deferred()
    const task = replies.consume(async () => { entered.resolve(); await release.promise; return [request()] }, async () => { assert.fail('Late automatic reply') }, signal())
    await entered.promise
    replies.stop()
    release.resolve()
    await assert.rejects(task)
  })

  it('does not dispatch later asks after cancellation during a previous reply', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    const entered = deferred(), release = deferred()
    const controller = new AbortController()
    const sent: string[] = []
    const task = replies.consume(async () => [request('one'), request('two')], async ({ id }) => {
      sent.push(id); entered.resolve(); await release.promise
    }, controller.signal)
    await entered.promise
    controller.abort()
    release.resolve()
    await assert.rejects(task)
    assert.deepEqual(sent, ['one'])
  })

  it('a new turn cannot revive an older queued automatic response', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    const entered = deferred(), release = deferred()
    const sent: string[] = []
    const first = replies.consume(async () => [request('one')], async ({ id }) => {
      sent.push(id); entered.resolve(); await release.promise
    }, signal())
    await entered.promise
    const stale = replies.consume(async () => [request('stale')], async ({ id }) => { sent.push(id) }, signal())
    // Attach rejection handlers before releasing the queue.
    const outcomes = Promise.allSettled([first, stale])
    replies.stop()
    replies.resume()
    const next = replies.consume(async () => [request('next')], async ({ id }) => { sent.push(id) }, signal())
    release.resolve()
    assert.ok((await outcomes).every((outcome) => outcome.status === 'rejected'))
    await next
    assert.deepEqual(sent, ['one', 'next'])
  })

  it('preserves reply identities when a canceled session is reused for a new turn', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    let sent = 0
    await replies.consume(async () => [request()], async () => { sent++ }, signal())
    replies.stop()
    replies.resume()
    await replies.consume(async () => [request(), request('next')], async () => { sent++ }, signal())
    assert.equal(sent, 2)
  })

  it('fails closed at the bounded receipt limit instead of evicting replay protection', async () => {
    const replies = new OpenCodeNativeAutoReplies()
    let sent = 0
    await replies.consume(async () => Array.from({ length: 4096 }, (_, index) => request(String(index))), async () => { sent++ }, signal())
    await assert.rejects(replies.consume(async () => [request('overflow')], async () => { sent++ }, signal()), errorCode('OPENCODE_NATIVE_AUTO_IDENTITY_LIMIT'))
    await replies.consume(async () => [request('0')], async () => { sent++ }, signal())
    assert.equal(sent, 4096)
  })
})
