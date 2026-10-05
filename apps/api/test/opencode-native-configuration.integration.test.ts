import assert from 'node:assert/strict'
import { expect, it } from 'vitest'
import { nativeMessageId, object, providerSupports } from '../src/modules/harnesses/opencodeProtocol.js'
import {
  nativeConfigurationFixture, nativeJson, nativePrompt,
} from './support/opencodeNativeConfiguration.js'

it('reattaches a persisted native fork after an unnamed turn initializes its default metadata', async () => {
  const f = await nativeConfigurationFixture()
  try {
    const { native, server } = f.allocate()
    const source = await native.createSession(f.start())
    assert.equal(source.providerVersion, '1.18.31')
    await nativeJson(server, f.directory, `/session/${source.nativeSessionId}/message`, {
      ...nativePrompt('source-history', 'parent', 'Source task'), agent: 'parent',
    })
    const before = await nativeJson(server, f.directory, `/session/${source.nativeSessionId}`)
    const fork = await native.forkSession(source, f.start())
    // A preexisting native caller omits the variant, producing the persisted default sentinel.
    const result = await nativeJson(server, f.directory, `/session/${fork.nativeSessionId}/message`, {
      ...nativePrompt('fork-default', 'parent', 'Fork task'), agent: 'parent',
    })
    assert.equal(object(result.info).finish, 'stop')
    assert.equal(object(result.info).error, undefined)
    const persisted = await nativeJson(server, f.directory, `/session/${fork.nativeSessionId}`)
    assert.equal(object(persisted.model).variant, 'default')
    assert.deepEqual(await nativeJson(server, f.directory, `/session/${source.nativeSessionId}`), before)
    await native.dispose()

    const restarted = f.allocate()
    assert.deepEqual(await restarted.native.attachSession(fork, f.start()), fork)
    for await (const event of restarted.native.startTurn(fork, {
      prompt: 'Continue the fork', clientCorrelationId: 'fork-after-restart',
    })) void event
    assert.equal((await restarted.native.reconcile(fork, 'fork-after-restart')).terminalResult?.outcome, 'succeeded')
  } finally {
    await f.close()
  }
}, 90_000)

it('keeps the unnamed choice in native user messages despite a custom agent named variant', async () => {
  const f = await nativeConfigurationFixture()
  try {
    const { native, server } = f.allocate()
    const session = await native.createSession(f.start({ ...f.harness, model: 'fixture/child', nativeAgent: 'reviewer' }))
    assert.equal(session.providerVersion, '1.18.31')
    const agents = await server.request(`/agent?directory=${encodeURIComponent(f.directory)}`)
    const reviewer = (await agents.json() as Record<string, unknown>[]).find(agent => agent.name === 'reviewer')!
    assert.equal(reviewer.variant, 'focused')
    const providers = await nativeJson(server, f.directory, '/provider')
    assert.equal(providerSupports(providers, 'fixture', 'child', ''), true)
    assert.equal(providerSupports(providers, 'fixture', 'child', 'focused'), true)
    assert.equal(providerSupports(providers, 'fixture', 'child', 'unadvertised'), false)
    for await (const event of native.startTurn(session, { prompt: 'Use the unnamed variant',
      clientCorrelationId: 'custom-unnamed',
    })) void event
    assert.equal((await native.reconcile(session, 'custom-unnamed')).terminalResult?.outcome, 'succeeded')
    const stored = await nativeJson(server, f.directory,
      `/session/${session.nativeSessionId}/message/${nativeMessageId('custom-unnamed')}`)
    assert.equal(object(stored.info).agent, 'reviewer')
    assert.deepEqual(object(stored.info).model, { providerID: 'fixture', modelID: 'child', variant: '' })
    assert.equal(object((await nativeJson(server, f.directory, `/session/${session.nativeSessionId}`)).model).variant, '')
    assert(f.calls.some(call => call.model === 'child'))
  } finally {
    await f.close()
  }
}, 90_000)

it('rejects named default variant metadata when reattaching an unnamed configuration after restart', async () => {
  const f = await nativeConfigurationFixture()
  try {
    const { native, server } = f.allocate()
    const named = { ...f.harness, variant: 'default' }
    const session = await native.createSession(f.start(named))
    for await (const event of native.startTurn(session, {
      prompt: 'Use the named default variant', clientCorrelationId: 'named-default',
    })) void event
    const stored = await nativeJson(server, f.directory,
      `/session/${session.nativeSessionId}/message/${nativeMessageId('named-default')}`)
    assert.equal(object(object(stored.info).model).variant, 'default')
    assert.equal(object((await nativeJson(server, f.directory, `/session/${session.nativeSessionId}`)).model).variant,
      'default')
    await native.dispose()
    const restarted = f.allocate()
    await expect(restarted.native.attachSession(session, f.start())).rejects.toMatchObject({
      result: { outcome: 'failed', error: { code: 'OPENCODE_SESSION_CONFIGURATION_MISMATCH' } },
    })
    assert.deepEqual(await restarted.native.attachSession(session, f.start(named)), session)
  } finally {
    await f.close()
  }
}, 90_000)
