import assert from 'node:assert/strict'
import { it } from 'vitest'
import { callOpenCodeSdk, createOpenCodeSdkClient } from '../src/modules/harnesses/opencodeSdkClient.js'
import type { OpenCodeHttpEvidence } from '../src/modules/harnesses/opencodeClient.js'
import { OpenCodeNativeDeliveryError, type OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'

it('official client-only SDK reads through the owned controller with raw cursor/status', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  const server: OpenCodeServerController = {
    generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31', ensure: async () => {}, dispose: async () => {},
    request: async (path, _init, _signal, generation) => {
      assert.equal(path, '/global/health?directory=%2Fwork')
      assert.equal(generation, 1)
      return new Response(JSON.stringify({ healthy: true, version: '1.18.31' }), { headers: { 'content-type': 'application/json', 'x-next-cursor': 'cursor' } })
    },
  }
  const client = createOpenCodeSdkClient({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) })
  const result = await client.global.health()
  assert.deepEqual(result.data, { healthy: true, version: '1.18.31' })
  assert.equal(result.response.status, 200)
  assert.equal(evidence[0]?.headers['x-next-cursor'], 'cursor')
})

it('SDK prompt ACK and lost accepted-body parse never retry native POST', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  let posts = 0
  const server: OpenCodeServerController = {
    generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31', ensure: async () => {}, dispose: async () => {},
    request: async (path, init) => {
      assert.equal(init?.method, 'POST')
      assert(path.endsWith('?directory=%2Fwork'))
      posts++
      return posts === 1 ? new Response(null, { status: 204 })
        : new Response('{truncated', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  const client = createOpenCodeSdkClient({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) })
  await client.session.promptAsync({ sessionID: 'root', messageID: 'exact', parts: [{ type: 'text', text: 'hello' }] })
  await assert.rejects(callOpenCodeSdk({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) },
    sdk => sdk.session.create({ title: 'fixture' })), /parsed acknowledgement is unavailable/)
  assert.equal(posts, 2)
  assert.deepEqual(evidence.map(value => value.status), [204, 200, 200])
  assert.equal(evidence.at(-1)?.bodyValidity, 'invalid')
})

it('records valid JSON rejection separately from the failed SDK mutation', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  let posts = 0
  const server: OpenCodeServerController = {
    generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31', ensure: async () => {}, dispose: async () => {},
    request: async () => {
      posts++
      return new Response(JSON.stringify({ name: 'ForbiddenError', data: { message: 'denied' } }),
        { status: 403, headers: { 'content-type': 'application/json' } })
    },
  }
  await assert.rejects(callOpenCodeSdk({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) },
    sdk => sdk.session.create({ title: 'fixture' })),
  error => error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite')
  assert.equal(posts, 1)
  assert.deepEqual(evidence.map(value => value.bodyValidity), ['unread', 'valid'])
  assert.equal(evidence.at(-1)?.status, 403)
})

it('keeps body unread when controller recovery refuses before response delivery', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  const refusal = new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED', 'Replaced before dispatch', 'definite')
  const server: OpenCodeServerController = {
    generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31', ensure: async () => {}, dispose: async () => {},
    request: async () => { throw refusal },
  }
  await assert.rejects(callOpenCodeSdk({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) },
    sdk => sdk.session.create({ title: 'fixture' })), error => error === refusal)
  assert.deepEqual(evidence.map(value => [value.dispatch, value.bodyValidity]), [['not_dispatched', 'unread']])
})

it('does not invent a body parse failure when application code fails after a decoded SDK response', async () => {
  const evidence: OpenCodeHttpEvidence[] = []
  const server: OpenCodeServerController = {
    generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31', ensure: async () => {}, dispose: async () => {},
    request: async () => new Response(JSON.stringify({ healthy: true, version: '1.18.31' }), { headers: { 'content-type': 'application/json' } }),
  }
  await assert.rejects(callOpenCodeSdk({ server, ownerAgentId: 'owner', directory: '/work', generation: 1, onEvidence: value => evidence.push(value) },
    async sdk => { await sdk.global.health(); throw new Error('application failure') }), /application failure/)
  assert.deepEqual(evidence.map(value => value.bodyValidity), ['unread', 'valid'])
})
