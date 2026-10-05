import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { FixtureServer, configuration, json, manager, permission, request, sessionFor } from './opencode-fixtures.js'
import type { NativeResponseAvailabilityQuery } from '../src/modules/harnesses/responseAvailability.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'

class ResidentFixture extends FixtureServer {
  ownerAgentId = 'agent-1'
  resident = true
  get residentGeneration() { return this.resident ? this.generation : undefined }
  readonly inspections: string[] = []
  beforeResident: ((path: string) => Promise<Response | undefined> | Response | undefined) | undefined
  async requestResident(path: string, signal: AbortSignal, generation: number): Promise<Response | undefined> {
    this.inspections.push(path)
    signal.throwIfAborted()
    if (!this.resident || generation !== this.generation) return undefined
    const intercepted = await this.beforeResident?.(path)
    if (intercepted) return intercepted
    const url = new URL(path, 'http://fixture.invalid')
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (url.pathname === '/permission') return json(structuredClone(this.permissions))
    if (segments[0] === 'session' && segments[1]) {
      if (segments[2] === 'message' && segments[3]) return json(this.messages.get(segments[1])?.find(value => value.info.id === segments[3]), 200)
      return this.sessionInfos.has(segments[1]) ? json(this.sessionInfos.get(segments[1])) : json({}, 404)
    }
    throw new Error('Unplanned resident read')
  }
}
const query = (id = 'request'): NativeResponseAvailabilityQuery => ({ nativeRequestId: id, nativeRequestType: 'permission.asked', expectedNativeTurnId: id })
function ask(server: ResidentFixture, id = 'request', sessionID = 'ses_test') {
  const request = permission(id, sessionID)
  delete request.tool
  server.permissions = [request]
  return request
}

it('reads exact current native recovery availability without ready, pending, auto replies or identity-map mutation', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  const request = ask(server)
  const sessions = Reflect.get(native, 'sessions') as Map<string, { pendingIds: Set<string>; ownedIds: Map<string, boolean> }>
  const state = sessions.get(session.nativeSessionId)!
  state.pendingIds.add('retained-unrelated-ask')
  const before = { pending: [...state.pendingIds], owned: [...state.ownedIds] }
  const ensure = vi.spyOn(server, 'ensure')
  const transport = vi.spyOn(server, 'request')
  try {
    const result = await native.inspectResponseAvailability(session, query())
    assert.equal(result.state, 'available')
    assert.equal(result.path, 'qualified_recovery')
    assert.equal(result.qualified, true)
    assert(result.generation)
    assert.equal(result.nativeTurnId, 'request')
    assert.equal(ensure.mock.calls.length, 0)
    assert.equal(transport.mock.calls.length, 0)
    assert.deepEqual({ pending: [...state.pendingIds], owned: [...state.ownedIds] }, before)
    assert.deepEqual(server.permissions, [request])
    assert.equal(server.inspections.filter(path => path.startsWith('/permission')).length, 2)
  } finally { vi.restoreAllMocks(); await native.dispose() }
})

it('normalizes only a proven root tool parent; descendants retain exact child identity', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  const turn = native.startTurn(session, { clientCorrelationId: 'owned', prompt: 'hello' })[Symbol.asyncIterator]()
  try {
    await turn.next()
    const root = nativeMessageId('owned')
    const message = server.assistant(root, 'tool', 'tool-calls', false)
    const rootAsk = permission('root-ask')
    object(rootAsk.tool).messageID = message.info.id
    server.permissions = [rootAsk]
    assert.equal((await native.inspectResponseAvailability(session, { ...query('root-ask'), expectedNativeTurnId: root })).state, 'available')
    server.addSession('child', session.nativeSessionId)
    const child = server.assistant('child-user', 'child tool', 'tool-calls', false, 'child')
    const childAsk = permission('child-ask', 'child')
    object(childAsk.tool).messageID = child.info.id
    server.permissions = [childAsk]
    assert.equal((await native.inspectResponseAvailability(session, { ...query('child-ask'), expectedNativeTurnId: String(child.info.id) })).state, 'available')
    assert.equal((await native.inspectResponseAvailability(session, { ...query('child-ask'), expectedNativeTurnId: root })).reason, 'identity_mismatch')
  } finally { await turn.return?.(); await native.dispose() }
})

it('fails closed for foreign requests, duplicate identities, unsupported questions and native-auto', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  try {
    server.addSession('foreign')
    ask(server, 'request', 'foreign')
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'identity_mismatch')
    ask(server)
    server.permissions.push(structuredClone(server.permissions[0]!))
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'identity_mismatch')
    const count = server.inspections.length
    assert.equal((await native.inspectResponseAvailability(session, { ...query(), nativeRequestType: 'question.asked' })).reason, 'unsupported')
    assert.equal(server.inspections.length, count)
  } finally { await native.dispose() }
  const autoServer = new ResidentFixture()
  const automatic = manager(autoServer)
  try {
    const automaticSession = await sessionFor(automatic, { ...configuration(), autoApprove: true })
    ask(autoServer)
    assert.equal((await automatic.inspectResponseAvailability(automaticSession, query())).reason, 'unsupported')
    assert.equal(autoServer.inspections.length, 0)
    assert.equal(autoServer.calls.filter(call => call.path.includes('/reply')).length, 0)
  } finally { await automatic.dispose() }
})

it('rechecks native consumption, generation and resident closure after awaited ancestry reads', async () => {
  for (const change of ['consume', 'generation', 'close'] as const) {
    const server = new ResidentFixture()
    const native = manager(server)
    const session = await sessionFor(native)
    ask(server)
    server.beforeResident = path => {
      if (path.includes('/session/')) {
        if (change === 'consume') server.permissions = []
        if (change === 'generation') server.generation++
        if (change === 'close') server.resident = false
      }
      return undefined
    }
    try {
      const result = await native.inspectResponseAvailability(session, query())
      assert.notEqual(result.state, 'available')
      assert.equal(result.reason, change === 'consume' ? 'request_consumed' : 'callback_lost')
      assert.equal(result.qualified, false)
      assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 0)
    } finally { await native.dispose() }
  }
})

it('reports in-flight and consumed exact responses without resending', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  ask(server)
  const option = (await native.pending(session))!.responseOptions[0]!
  let resolve!: (response: Response) => void
  let started!: () => void
  const dispatch = new Promise<void>(value => { started = value })
  server.onConnection = () => server.closeStreams()
  server.beforeRequest = path => path.includes('/reply') ? new Promise<Response>(value => { resolve = value; started() }) : undefined
  try {
    const responding = native.respond(session, 'request', option)
    await dispatch
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'response_in_flight')
    resolve(json(true))
    await responding
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'request_consumed')
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 1)
  } finally { await native.dispose() }
})

it('does not turn an uncertain prior reply into available recovery or another native POST', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  ask(server)
  const option = (await native.pending(session))!.responseOptions[0]!
  server.onConnection = () => server.closeStreams()
  server.beforeRequest = path => path.includes('/reply') ? json(false) : undefined
  try {
    await assert.rejects(native.respond(session, 'request', option))
    const result = await native.inspectResponseAvailability(session, query())
    assert.equal(result.state, 'recovery_required')
    assert.equal(result.reason, 'callback_lost')
    await assert.rejects(native.respond(session, 'request', option))
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 1)
  } finally { await native.dispose() }
})

it('does not start or qualify a missing/stale/foreign resident owner', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  ask(server)
  try {
    server.resident = false
    assert.equal((await native.inspectResponseAvailability(session, query())).state, 'recovery_required')
    server.resident = true
    server.ownerAgentId = 'foreign'
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'unqualified')
    assert.equal(server.inspections.length, 0)
    await native.dispose()
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'session_closed')
  } finally { await native.dispose() }
})

it('cancels a suspended response-body reader when inspection is aborted', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  ask(server)
  let canceled = false
  let started!: () => void
  const bodyRead = new Promise<void>(resolve => { started = resolve })
  server.beforeResident = path => path.startsWith('/permission') ? new Response(new ReadableStream<Uint8Array>({
    pull() { started() }, cancel() { canceled = true },
  })) : undefined
  const abort = new AbortController()
  try {
    const availability = native.inspectResponseAvailability(session, query(), abort.signal)
    await bodyRead
    abort.abort()
    assert.equal((await availability).state, 'unavailable')
    assert.equal(canceled, true)
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 0)
  } finally { await native.dispose() }
})


it('does not qualify a request when native ordered policy differs from the accepted session', async () => {
  const server = new ResidentFixture()
  const native = manager(server)
  const session = await sessionFor(native)
  ask(server)
  server.sessionInfos.get(session.nativeSessionId)!.permission = []
  try {
    assert.equal((await native.inspectResponseAvailability(session, query())).reason, 'unqualified')
    assert.equal(server.calls.filter(call => call.path.includes('/reply')).length, 0)
  } finally { await native.dispose() }
})

it('answers an owned permission after attaching saved provenance under a newer compatible server', async () => {
  const server = new ResidentFixture()
  const original = manager(server)
  const saved = await sessionFor(original)
  await original.dispose()
  server.expectedVersion = '2.0.0'
  server.beforeRequest = path => path === '/global/health' ? json({ healthy: true, version: '2.0.0' }) : undefined
  const native = manager(server)
  try {
    assert.deepEqual(await native.attachSession(saved, { request: request() }), saved)
    ask(server)
    const availability = await native.inspectResponseAvailability(saved, query())
    assert.equal(availability.state, 'available')
    assert.equal(availability.qualified, true)
    const pending = await native.pending(saved)
    assert(pending)
    await native.respond(saved, 'request', pending.responseOptions[0]!)
    assert(server.calls.some(call => call.path.startsWith('/permission/request/reply')))
    assert.equal(saved.providerVersion, '1.18.31')
    assert.equal((await native.capabilities()).providerVersion, '2.0.0')
  } finally { await native.dispose() }
})
