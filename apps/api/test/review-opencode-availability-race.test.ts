import assert from 'node:assert/strict'
import { it } from 'vitest'
import { FixtureServer, json, manager, permission, sessionFor } from './opencode-fixtures.js'

it('F-12 rechecks uncertainty when a concurrent reply loses its ACK during resident inspection', async () => {
  const server = new FixtureServer()
  Object.defineProperties(server, {
    ownerAgentId: { value: 'agent-1' },
    residentGeneration: { get: () => server.generation },
  })
  let entered!: () => void
  let release!: () => void
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  Object.assign(server, {
    async requestResident(path: string, signal: AbortSignal, generation: number) {
      signal.throwIfAborted()
      assert.equal(generation, server.generation)
      const url = new URL(path, 'http://fixture.invalid')
      if (url.pathname === '/permission') return json(server.permissions)
      entered()
      await barrier
      return json(server.sessionInfos.get(decodeURIComponent(url.pathname.split('/')[2]!)))
    },
  })
  const native = manager(server)
  const session = await sessionFor(native)
  const ask = permission('request')
  delete ask.tool
  server.permissions = [ask]
  const option = (await native.pending(session))!.responseOptions[0]!
  server.onConnection = () => server.closeStreams()
  server.beforeRequest = path => path.includes('/reply') ? json(false) : undefined
  try {
    const availability = native.inspectResponseAvailability(session, {
      nativeRequestId: 'request', nativeRequestType: 'permission.asked', expectedNativeTurnId: 'request',
    })
    await blocked
    await assert.rejects(native.respond(session, 'request', option))
    release()
    const result = await availability
    assert.equal(result.state, 'recovery_required')
    assert.equal(result.reason, 'callback_lost')
    assert.equal(result.qualified, false)
    await assert.rejects(native.respond(session, 'request', option))
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 1)
  } finally { release(); await native.dispose() }
})
