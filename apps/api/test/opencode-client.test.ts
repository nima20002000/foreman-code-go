import assert from 'node:assert/strict'
import { it } from 'vitest'
import { classifyOpenCodeDelivery, createOpenCodeBoundFetch, type OpenCodeHttpEvidence } from '../src/modules/harnesses/opencodeClient.js'
import { OpenCodeNativeDeliveryError, type OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'

function controller(request: OpenCodeServerController['request']): OpenCodeServerController {
  return { generation: 7, ownerAgentId: 'alice', expectedVersion: '1.18.31', request, ensure: async () => {}, dispose: async () => {} }
}
it('captures raw HTTP evidence before any accepted-body parsing without secret headers', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  let posts = 0
  const server = controller(async (path, init, _signal, generation) => {
    assert.equal(path, '/session/root/prompt_async?directory=%2Fwork')
    assert.equal(generation, 7)
    assert.equal(init?.method, 'POST')
    posts++
    return new Response('{truncated', { status: 200, headers: { 'x-next-cursor': 'next', 'set-cookie': 'secret' } })
  })
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, onEvidence: e => evidence.push(e) })
  const response = await fetch('http://opencode.invalid/session/root/prompt_async?directory=%2Fwork', { method: 'POST', body: '{}' })
  assert.equal(evidence[0]?.status, 200)
  assert.equal(evidence[0]?.headers['x-next-cursor'], 'next')
  assert.equal(evidence[0]?.headers['set-cookie'], undefined)
  await assert.rejects(response.json())
  assert.equal(classifyOpenCodeDelivery({ ...evidence[0]!, bodyValidity: 'invalid' }), 'acknowledged')
  assert.equal(posts, 1)
})
it('rejects stale generation, foreign owner and directory before dispatch', async () => {
  let posts = 0
  const evidence: OpenCodeHttpEvidence[] = []
  const server = controller(async () => { posts++; return new Response('{}') })
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, onEvidence: value => evidence.push(value) })
  Object.assign(server, { generation: 8 }) // test controllers intentionally simulate replacement
  await assert.rejects(fetch('http://opencode.invalid/session/root?directory=%2Fwork'), /no longer owned/)
  Object.assign(server, { generation: 7 })
  await assert.rejects(fetch('http://opencode.invalid/session/root?directory=%2Fother'), /no longer owned/)
  await assert.rejects(fetch('http://foreign.invalid/session/root?directory=%2Fwork'), /no longer owned/)
  assert.equal(posts, 0)
  assert.equal(evidence.length, 3)
  assert(evidence.every(value => value.dispatch === 'not_dispatched' && value.bodyValidity === 'unread'))
})
it('preserves controller recovery refusal after the wrapper generation preflight passes', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  let rawPosts = 0
  const server = controller(async (_path, _init, _signal, generation) => {
    assert.equal(generation, server.generation)
    Object.assign(server, { generation: 8 }) // ensure replaced a dead process before rawRequest
    if (generation !== server.generation) {
      throw new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED', 'Replaced before dispatch', 'definite')
    }
    rawPosts++; return new Response('{}')
  })
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, onEvidence: value => evidence.push(value) })
  await assert.rejects(fetch('http://opencode.invalid/session?directory=%2Fwork', { method: 'POST' }),
    error => error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite')
  assert.equal(rawPosts, 0)
  assert.equal(evidence[0]?.dispatch, 'not_dispatched')
  assert.equal(classifyOpenCodeDelivery(evidence[0]!), 'definite rejection')
})
it('keeps unknown controller connection failures dispatched and unread', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  const server = controller(async () => { throw new Error('connection lost') })
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, onEvidence: value => evidence.push(value) })
  await assert.rejects(fetch('http://opencode.invalid/session?directory=%2Fwork', { method: 'POST' }), /connection lost/)
  assert.equal(evidence[0]?.dispatch, 'dispatched')
  assert.equal(evidence[0]?.bodyValidity, 'unread')
  assert.equal(classifyOpenCodeDelivery(evidence[0]!), 'uncertain')
})
it('fences a generation replacement while a mutation is awaiting its ACK', async () => {
  let resolve!: (response: Response) => void
  const server = controller(() => new Promise<Response>(r => { resolve = r }))
  const evidence: OpenCodeHttpEvidence[] = []
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, onEvidence: e => evidence.push(e) })
  const pending = fetch('http://opencode.invalid/session/root?directory=%2Fwork', { method: 'POST' })
  Object.assign(server, { generation: 8 })
  resolve(new Response('{}'))
  await assert.rejects(pending, /generation or owner lifetime changed/)
  assert.equal(evidence[0]?.status, 200)
})
it('keeps dispatch, raw status and body validity distinct', () => {
  const base: OpenCodeHttpEvidence = { operation: { method: 'POST', path: '/permission/reply' }, ownerAgentId: 'alice', directory: '/work', generation: 7, dispatch: 'dispatched', headers: {}, bodyValidity: 'invalid' }
  assert.equal(classifyOpenCodeDelivery(base), 'uncertain')
  assert.equal(classifyOpenCodeDelivery({ ...base, status: 503 }), 'uncertain')
  assert.equal(classifyOpenCodeDelivery({ ...base, status: 403 }), 'definite rejection')
  assert.equal(classifyOpenCodeDelivery({ ...base, status: 200 }), 'acknowledged')
  assert.equal(classifyOpenCodeDelivery({ ...base, dispatch: 'not_dispatched' }), 'definite rejection')
})
it('fences an aborted owner lifetime even when an injected controller returns a late ACK', async () => {
  let resolve!: (response: Response) => void
  const lifetime = new AbortController()
  const server = controller(() => new Promise<Response>(r => { resolve = r }))
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7, signal: lifetime.signal })
  const pending = fetch('http://opencode.invalid/session/root?directory=%2Fwork', { method: 'POST' })
  lifetime.abort()
  resolve(new Response('{}'))
  await assert.rejects(pending, /owner lifetime changed/)
})

it('retains an accepted response after observer detachment while the owner remains current', async () => {
  const observer = new AbortController()
  const owner = new AbortController()
  let finish!: (response: Response) => void
  const server = controller(() => new Promise<Response>(resolve => { finish = resolve }))
  const fetch = createOpenCodeBoundFetch({ server, directory: '/work', ownerAgentId: 'alice', generation: 7,
    signal: observer.signal, ownerSignal: owner.signal })
  const pending = fetch('http://opencode.invalid/session/root/prompt_async?directory=%2Fwork', { method: 'POST' })
  observer.abort()
  finish(new Response(null, { status: 204 }))
  assert.equal((await pending).status, 204)
})
