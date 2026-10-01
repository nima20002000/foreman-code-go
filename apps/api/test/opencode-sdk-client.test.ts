import assert from 'node:assert/strict'
import { it } from 'vitest'
import { callOpenCodeSdk, createOpenCodeSdkClient } from '../src/modules/harnesses/opencodeSdkClient.js'
import type { OpenCodeHttpEvidence } from '../src/modules/harnesses/opencodeClient.js'
import type { OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'

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
