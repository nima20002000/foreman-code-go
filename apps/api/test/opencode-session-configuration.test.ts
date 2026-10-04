import assert from 'node:assert/strict'
import { it } from 'vitest'
import { configuration, environment, errorCode, FixtureServer, manager, request, sessionFor } from './opencode-fixtures.js'

it.each([undefined, '', 'default'])('reattaches an unnamed variant stored as %s', async variant => {
  const server = new FixtureServer()
  const harness = { ...configuration(), variant: '' }
  const original = manager(server)
  const restarted = manager(server)
  try {
    const session = await sessionFor(original, harness)
    const info = server.sessionInfos.get(session.nativeSessionId)!
    info.model = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant }
    assert.deepEqual(await restarted.attachSession(session, { request: request(harness), environment: environment() }), session)
    assert.equal(server.calls.filter(call => call.method === 'POST' && call.path.startsWith('/session?')).length, 1)
  } finally {
    await restarted.dispose()
    await original.dispose()
  }
})

it.each([
  [{ agent: 'plan' }, 'OPENCODE_SESSION_CONFIGURATION_MISMATCH'],
  [{ model: { providerID: 'other', id: 'deepseek-v4.1-flash', variant: 'default' } }, 'OPENCODE_SESSION_CONFIGURATION_MISMATCH'],
  [{ model: { providerID: 'opencode-go', id: 'other', variant: 'default' } }, 'OPENCODE_SESSION_CONFIGURATION_MISMATCH'],
  [{ model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' } }, 'OPENCODE_SESSION_CONFIGURATION_MISMATCH'],
  [{ permission: [] }, 'OPENCODE_SESSION_PERMISSION_MISMATCH'],
  [{ directory: '/other' }, 'OPENCODE_SESSION_DIRECTORY_MISMATCH'],
] as const)('keeps attachment configuration checks for %j', async (changes, code) => {
  const server = new FixtureServer()
  const harness = { ...configuration(), variant: '' }
  const original = manager(server)
  const restarted = manager(server)
  try {
    const session = await sessionFor(original, harness)
    Object.assign(server.sessionInfos.get(session.nativeSessionId)!, changes)
    await assert.rejects(restarted.attachSession(session, {
      request: request(harness), environment: environment(),
    }), errorCode(code))
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 0)
  } finally {
    await restarted.dispose()
    await original.dispose()
  }
})

it('does not accept the default sentinel for a pinned named variant', async () => {
  const server = new FixtureServer()
  const original = manager(server)
  const restarted = manager(server)
  try {
    const session = await sessionFor(original)
    server.sessionInfos.get(session.nativeSessionId)!.model = {
      providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default',
    }
    await assert.rejects(restarted.attachSession(session, {
      request: request(), environment: environment(),
    }), errorCode('OPENCODE_SESSION_CONFIGURATION_MISMATCH'))
  } finally {
    await restarted.dispose()
    await original.dispose()
  }
})
