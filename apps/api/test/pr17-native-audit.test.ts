import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, it, vi } from 'vitest'
import type { OperatorNativeSessionStart } from '../src/modules/harnesses/port.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import { FixtureServer, configuration, environment, manager as openCodeManager, permission, request, sessionFor } from './opencode-fixtures.js'
import { calls, collect, errorCode, fixture, fixtureQualification, input, until, type Fixture } from './fixtures/codex-test-helpers.js'

// Replace binary/schema qualification only. Lifecycle and transport code remain real.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')
const { OpenCodeNativeDeliveryError } = await import('../src/modules/harnesses/opencodeServer.js')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Native fixture cleanup failed.')
})
async function codexFixture(): Promise<Fixture> {
  const value = await fixture()
  cleanups.push(() => rm(value.directory, { recursive: true, force: true }))
  return value
}
function codexManager(f: Fixture) {
  const native = new CodexAppServerSessionManager(f.binary)
  cleanups.push(() => native.dispose())
  return native
}
function openCodeFixture(cold = false) {
  const server = new FixtureServer()
  if (cold) server.environment = environment()
  const native = openCodeManager(server)
  cleanups.push(() => native.dispose())
  return { server, native }
}

describe.skipIf(process.platform === 'win32')('PR17 Codex native recovery', () => {
  it('F01: accepts the scoped GraphQL credential through the Operator session path and rejects app-global secrets', async () => {
    const f = await codexFixture()
    const worker = input(f.directory)
    worker.environment = { agentId: 'agent-a', variables: { ...worker.environment!.variables, GRAPHQL_OPERATOR_MCP_TOKEN: 'fixture-scoped-operator' } }
    await assert.rejects(codexManager(f).createSession(worker), (error: unknown) => errorCode(error) === 'CODEX_ENVIRONMENT_INVALID')
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
      transport: { type: 'streamable_http', url: 'http://127.0.0.1:4100/mcp', bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } }))
    const source = input(f.directory)
    const operator: OperatorNativeSessionStart = {
      kind: 'operator', correlationId: 'operator-turn', workingDirectory: f.directory,
      configuration: { id: 'operator-version', operatorId: 'agent-a', version: 1,
        harness: source.request.configuration.harness, contentHash: 'sha256:fixture', createdAt: '2026-09-16T00:00:00.000Z' },
      environment: { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_MCP_TOKEN: 'fixture-scoped-operator' } },
    }
    const native = codexManager(f)
    const session = await native.createSession(operator)
    await collect(native.startTurn(session, { prompt: 'complete', clientCorrelationId: 'operator-turn' }))
    assert.equal((await native.reconcile(session, 'operator-turn')).terminalResult?.outcome, 'succeeded')
  })

  it('F06: successful Codex receipts retain the same assistant identity on repeated reconciliation', async () => {
    const f = await codexFixture(); const native = codexManager(f)
    const session = await native.createSession(input(f.directory))
    await collect(native.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const first = await native.reconcile(session, 'first')
    assert(first.nativeMessageId)
    assert.equal(first.nativeMessageId, `answer-${first.nativeTurnId}`)
    for (let count = 0; count < 3; count++) assert.equal((await native.reconcile(session, 'first')).nativeMessageId, first.nativeMessageId)
  })

  for (const durableId of [false, true]) it(`F07/F08: a new manager recovers the exact older turn with durable identity=${durableId}`, async () => {
    const f = await codexFixture(); const old = codexManager(f); const source = input(f.directory)
    const session = await old.createSession(source)
    await collect(old.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const first = await old.reconcile(session, 'first')
    const connection = first.events[0]?.connectionId
    assert(connection)
    await collect(old.startTurn(session, { prompt: 'complete', clientCorrelationId: 'later' }))
    const later = await old.reconcile(session, 'later')
    assert.notEqual(later.nativeMessageId, first.nativeMessageId)
    await old.dispose()
    const fresh = codexManager(f)
    await fresh.attachSession(session, { ...source, correlationId: 'first', ...(durableId ? { nativeTurnId: first.nativeTurnId! } : {}) })
    const restored = await fresh.reconcile(session, 'first')
    assert.equal(restored.correlationId, 'first')
    assert.equal(restored.nativeMessageId, first.nativeMessageId)
    assert.equal(restored.terminalTurn?.providerId, first.nativeTurnId)
    assert(restored.events.every((event) => event.connectionId && event.connectionId !== connection))
    const replay = await fresh.history(session)
    assert.equal(replay.events[0]?.connectionId, restored.events[0]?.connectionId)
    assert.equal((await calls(f.directory)).filter((entry) => (entry.wire as { method?: string } | undefined)?.method === 'turn/start').length, 2)
  })

  it('F13: disposal closes the actual child while thread creation has no returned identity', async () => {
    const f = await codexFixture(); const native = codexManager(f)
    await writeFile(join(f.directory, 'late-thread-start'), '')
    const creating = native.createSession(input(f.directory))
    void creating.catch(() => undefined)
    await until(async () => (await calls(f.directory)).some((entry) => (entry.wire as { method?: string } | undefined)?.method === 'thread/start'))
    const pid = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')?.pid
    assert.equal(typeof pid, 'number')
    await native.dispose()
    await assert.rejects(creating)
    await until(async () => { try { process.kill(pid as number, 0); return false } catch { return true } })
  })
})

describe('PR17 OpenCode native recovery', () => {
  it('F05/F06: history replay and cached success preserve identity without exposing a scoped token', async () => {
    const { server, native } = openCodeFixture(); const session = await sessionFor(native)
    const root = server.user('first')
    const answer = server.assistant(String(root.info.id), 'output fixture-owner-token')
    const first = await native.reconcile(session, 'first')
    assert.equal(first.nativeMessageId, answer.info.id)
    assert(!JSON.stringify(first).includes('fixture-owner-token'))
    const replay = await native.reconcile(session, 'first')
    assert.equal(replay.nativeMessageId, answer.info.id)
    assert.equal(replay.terminalResult?.outcome, 'succeeded')
    assert(!JSON.stringify(await native.historyPage(session)).includes('fixture-owner-token'))
  })

  it('F09: cold attachment can cancel its verified active turn without submitting a prompt', async () => {
    const { server, native } = openCodeFixture(true)
    server.addSession('ses_test', undefined, configuration())
    server.user('active'); server.statuses.set('ses_test', { type: 'busy' }); server.permissions = [permission('request-1')]
    const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'ses_test' }
    await native.attachSession(session, { request: request(), correlationId: 'active', nativeTurnId: nativeMessageId('active') })
    assert.equal(await native.cancel(session, undefined, nativeMessageId('active')), true)
    assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 1)
    assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')).length, 0)
  })

  it('F09: targeted cancellation cannot abort a newer real user turn', async () => {
    const { server, native } = openCodeFixture(true)
    server.addSession('ses_test'); server.user('older'); server.user('newer')
    server.statuses.set('ses_test', { type: 'busy' })
    const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'ses_test' }
    await native.attachSession(session, { request: request(), correlationId: 'older', nativeTurnId: nativeMessageId('older') })
    assert.equal(await native.cancel(session, undefined, nativeMessageId('older')), false)
    assert.equal(server.calls.filter((call) => call.path.includes('/abort')).length, 0)
  })

  it('F10: an exact provider event recovers a lost HTTP acknowledgement without another reply', async () => {
    const { server, native } = openCodeFixture(); const session = await sessionFor(native)
    server.permissions = [permission('request-1')]
    const pending = (await native.pending(session))!
    const option = pending.responseOptions.find((value) => value.semantic === 'approve_once')!
    server.beforeRequest = (path) => {
      if (!path.includes('/permission/request-1/reply')) return undefined
      server.permissions = []
      server.emit('permission.replied', { sessionID: 'ses_test', requestID: 'request-1', reply: 'once' })
      throw new OpenCodeNativeDeliveryError('LOST_ACK', 'fixture response lost after acceptance', 'uncertain')
    }
    await native.respond(session, 'request-1', option)
    const recovered = await native.reconcileResponse(session, { nativeRequestId: 'request-1', nativeRequestType: pending.nativeRequestType, option })
    assert.equal(recovered.responseDeliveries?.[0]?.optionId, option.optionId)
    assert.equal(server.calls.filter((call) => call.path.includes('/permission/request-1/reply')).length, 1)
  })

  it('F10: a saved native acknowledgement can repair failed caller persistence without a model-turn lookup', async () => {
    const { server, native } = openCodeFixture(); const session = await sessionFor(native)
    server.permissions = [permission('request-1')]
    const pending = (await native.pending(session))!; const option = pending.responseOptions[0]!
    await native.respond(session, 'request-1', option)
    // The caller failed to commit its delivered marker. It now uses only response reconciliation.
    const before = server.calls.length
    const recovered = await native.reconcileResponse(session, { nativeRequestId: 'request-1', nativeRequestType: pending.nativeRequestType, option })
    assert.equal(recovered.responseDeliveries?.length, 1)
    assert(!server.calls.slice(before).some((call) => call.path.includes('/message/') || call.method === 'POST'))
  })

  it('F10: disappearance alone and mismatched choices never produce delivery evidence', async () => {
    const { server, native } = openCodeFixture(); const session = await sessionFor(native)
    server.permissions = [permission('request-1')]
    const pending = (await native.pending(session))!; const option = pending.responseOptions[0]!
    server.permissions = []
    const unknown = await native.reconcileResponse(session, { nativeRequestId: 'request-1', nativeRequestType: pending.nativeRequestType, option })
    assert.deepEqual(unknown.responseDeliveries, [])
    assert.equal(server.calls.filter((call) => call.path.includes('/reply')).length, 0)
  })
})
