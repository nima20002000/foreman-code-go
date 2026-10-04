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

it('retains an advertised named variant whose name is default', async () => {
  const server = new FixtureServer()
  server.providers = { all: [{ id: 'opencode-go', models: {
    'deepseek-v4.1-flash': { variants: { default: {} } },
  } }] }
  const harness = { ...configuration(), variant: 'default' }
  const original = manager(server)
  const restarted = manager(server)
  try {
    const session = await sessionFor(original, harness)
    assert.deepEqual(await restarted.attachSession(session, {
      request: request(harness), environment: environment(),
    }), session)
  } finally {
    await restarted.dispose()
    await original.dispose()
  }
})

it('sends the explicit unnamed choice even when the native agent has a named default', async () => {
  const server = new FixtureServer()
  server.agents = [{ name: 'custom', variant: 'max',
    model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' } }]
  const native = manager(server)
  try {
    const session = await sessionFor(native, { ...configuration(), nativeAgent: 'custom', variant: '' })
    server.onPrompt = () => { server.complete('custom-unnamed', 'Done', session.nativeSessionId) }
    for await (const event of native.startTurn(session, {
      prompt: 'Use the unnamed variant', clientCorrelationId: 'custom-unnamed',
    })) void event
    assert.deepEqual(server.sessionInfos.get(session.nativeSessionId)!.model, {
      providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: '',
    })
    const prompt = server.calls.find(call => call.path.includes('/prompt_async'))!.body!
    assert.equal(prompt.agent, 'custom')
    assert.equal(prompt.variant, '')
  } finally {
    await native.dispose()
  }
})
