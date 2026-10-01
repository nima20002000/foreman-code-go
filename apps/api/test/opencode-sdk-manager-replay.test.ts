import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { FixtureServer, json, permission, sessionFor } from './opencode-fixtures.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { sdkQualificationClient } from './support/opencodeSdkQualification.js'

async function replay(sdk: boolean) {
  const server = new FixtureServer()
  const sdkCalls: string[] = []
  const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-sdk-replay-'))
  const journal = new NativeResponseJournal(directory)
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', responseJournal: journal,
    ...(sdk ? { clientFactory: sdkQualificationClient(sdkCalls) } : {}),
  })
  try {
    const session = await sessionFor(native)
    server.onPrompt = () => { server.complete('sdk-manager', 'exact final answer') }
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'sdk-manager' })) void event
    const history = await native.reconcile(session, 'sdk-manager')
    server.permissions = [permission('exact-reply')]
    const option = (await native.pending(session))!.responseOptions[0]!
    await native.respond(session, 'exact-reply', option)
    const identity = { nativeRequestId: 'exact-reply', nativeRequestType: 'permission.asked', option }
    const proof = journal.read(session, identity)
    assert.equal(proof?.nativeRequestId, 'exact-reply')
    const cold = new OpenCodeNativeSessionManager({ ownerAgentId: 'agent-1', responseJournal: journal, server: {
      ownerAgentId: 'agent-1', expectedVersion: '1.18.31',
      ensure: async () => { throw new Error('Cold receipt read must not acquire native resources') },
      request: async () => { throw new Error('Cold receipt read must not dispatch native requests') },
      dispose: async () => {},
    } })
    const deliveries = (await cold.reconcileResponse(session, identity)).responseDeliveries
    assert.equal((await cold.inspectResponseAvailability(session, { nativeRequestId: 'exact-reply', nativeRequestType: 'permission.asked' })).reason, 'session_closed')
    return { session, terminal: history.terminalResult, turn: history.nativeTurnId, deliveries,
      mutations: server.calls.filter(call => call.method !== 'GET'), sdkCalls, server }
  } finally { await native.dispose(); await rm(directory, { recursive: true, force: true }) }
}

it('compares raw and generated SDK critical operations beneath the real manager through prompt/history/approval recovery', async () => {
  const raw = await replay(false)
  const sdk = await replay(true)
  assert.deepEqual(sdk.session, raw.session)
  assert.deepEqual(sdk.terminal, raw.terminal)
  assert.equal(sdk.turn, nativeMessageId('sdk-manager'))
  assert.deepEqual(sdk.deliveries, raw.deliveries)
  assert.deepEqual(sdk.mutations, raw.mutations)
  for (const method of ['health', 'create', 'prompt', 'permissions', 'reply', 'status']) assert(sdk.sdkCalls.includes(method))
  assert.equal(sdk.mutations.filter(call => call.path.includes('/prompt_async')).length, 1)
  assert.equal(sdk.mutations.filter(call => call.path.includes('/permission/exact-reply/reply')).length, 1)
})

it('SDK manager replay reconciles lost accepted prompt ACK with zero raw fallback/resend', async () => {
  const server = new FixtureServer()
  const calls: string[] = []
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', clientFactory: sdkQualificationClient(calls) })
  try {
    const session = await sessionFor(native)
    server.onPrompt = () => { server.complete('lost-sdk-ack'); throw new Error('ACK disconnected') }
    await assert.rejects(async () => {
      for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'lost-sdk-ack' })) void event
    })
    assert.equal((await native.reconcile(session, 'lost-sdk-ack')).terminalResult?.outcome, 'succeeded')
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
    assert.equal(calls.filter(value => value === 'prompt').length, 1)
  } finally { await native.dispose() }
})

it('SDK false permission acknowledgement stays uncertain and cannot advertise or repeat native delivery', async () => {
  const server = new FixtureServer()
  const calls: string[] = []
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', clientFactory: sdkQualificationClient(calls) })
  try {
    const session = await sessionFor(native)
    server.permissions = [permission('uncertain-sdk-reply')]
    const option = (await native.pending(session))!.responseOptions[0]!
    server.onConnection = () => server.closeStreams()
    server.beforeRequest = path => path.includes('/reply') ? json(false) : undefined
    await assert.rejects(native.respond(session, 'uncertain-sdk-reply', option))
    await assert.rejects(native.respond(session, 'uncertain-sdk-reply', option))
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 1)
    assert.equal(calls.filter(value => value === 'reply').length, 1)
  } finally { await native.dispose() }
})

it('keeps accepted SDK prompt identity when the task observer detaches before the ACK callback', async () => {
  const server = new FixtureServer()
  const calls: string[] = []
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', clientFactory: sdkQualificationClient(calls) })
  const observer = new AbortController()
  const submitted: string[] = []
  try {
    const session = await sessionFor(native)
    server.onPrompt = () => observer.abort()
    await assert.rejects(async () => {
      for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'sdk-detached-acceptance',
        onSubmitted: async id => { submitted.push(id) },
      }, observer.signal)) void event
    })
    assert.deepEqual(submitted, [nativeMessageId('sdk-detached-acceptance')])
    assert.equal(calls.filter(value => value === 'prompt').length, 1)
    assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
  } finally { await native.dispose() }
})

it('uses the selected SDK history/cursor methods for a root and selected answer on older pages', async () => {
  const server = new FixtureServer()
  const calls: string[] = []
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', clientFactory: sdkQualificationClient(calls) })
  try {
    const session = await sessionFor(native)
    const root = server.user('older-sdk-root')
    server.assistant(String(root.info.id), 'selected older answer')
    for (let index = 0; index < 250; index++) server.user(`unrelated-${index}`, `unrelated input ${index}`)
    const history = await native.reconcile(session, 'older-sdk-root')
    assert.equal(history.terminalResult?.outcome, 'succeeded')
    assert.equal(object(history.terminalResult?.output).text, 'selected older answer')
    assert(calls.includes('message'))
    assert(calls.filter(value => value === 'messages').length >= 2)
    assert(server.calls.some(value => value.path.includes('before=opaque-page%3A')))
  } finally { await native.dispose() }
})
