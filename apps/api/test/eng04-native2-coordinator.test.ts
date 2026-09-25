import assert from 'node:assert/strict'
import { test } from 'vitest'
import { HarnessExecutionRequestSchema } from '@graphql/contracts'
import { DomainError } from '../src/modules/errors.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

const pending = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'REPEAT_CLEANUP_PENDING')

test('NATIVE-2 terminal SQL-only replay has zero physical or allocation calls', async () => {
  const f = native2Fixture(); f.settled()
  assert.equal((await f.observe()).state, 'completed')
  assert.deepEqual(f.calls, [`read:${f.get().id}`, `settle:${f.get().id}`])
})

test('NATIVE-2 missing closure is not permission to resolve/start a cleanup process', async () => {
  const f = native2Fixture()
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => /resolve|startTurn|createSession|attachSession|capabilities|revoke/.test(call)))
})

test('NATIVE-2 captured close, durable receipt and principal revocation precede settlement', async () => {
  const f = native2Fixture(); f.installResident()
  assert.equal((await f.observe()).state, 'completed')
  const close = f.calls.indexOf(`close:${f.session.nativeSessionId}`)
  assert.ok(close >= 0)
  assert.ok(f.calls.indexOf('closure:41') > close)
  assert.ok(f.calls.indexOf('revoke:principal-native2-captured') > f.calls.indexOf('closure:41'))
  assert.ok(f.calls.lastIndexOf(`settle:${f.get().id}`) > f.calls.indexOf('release-manager'))
  assert.ok(!f.calls.some((call) => call.startsWith('revoke-execution:')))
})

test('NATIVE-2 lost revocation reply retries the captured principal without another close', async () => {
  const f = native2Fixture(); f.installResident()
  const revoke = f.credentials.revoke
  let first = true
  f.credentials.revoke = async (identity) => {
    if (first) { first = false; throw new Error('synthetic revocation reply gap') }
    await revoke(identity)
  }
  await assert.rejects(f.observe())
  assert.equal((await f.observe()).state, 'completed')
  assert.equal(f.calls.filter((call) => call.startsWith('close:')).length, 1)
  assert.equal(f.calls.filter((call) => call === 'revoke:principal-native2-captured').length, 1)
})

test('NATIVE-2 close/receipt gap never manufactures closure and retries only the same close', async () => {
  const f = native2Fixture(); f.installResident()
  const record = f.closures.record
  let first = true
  f.closures.record = async (...args) => {
    if (first) { first = false; throw new Error('synthetic close receipt COMMIT gap') }
    return record(...args)
  }
  await assert.rejects(f.observe())
  assert.equal(f.getProof(), undefined)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke:')))
  await f.observe()
  assert.deepEqual(f.calls.filter((call) => call.startsWith('close:')), Array(2).fill(`close:${f.session.nativeSessionId}`))
})

test('NATIVE-2 owner loss after physical close cannot revoke or release replacement authority', async () => {
  const f = native2Fixture(); f.installResident()
  f.manager.close = async () => { f.loseOwner() }
  await assert.rejects(f.observe())
  assert.ok(!f.calls.some((call) => call.startsWith('revoke') || call === 'release-manager'))
})

test('NATIVE-2 manager generation replacement rejects late close publication', async () => {
  const f = native2Fixture(); f.installResident()
  f.manager.close = async () => { f.resident.generation++ }
  await assert.rejects(f.observe())
  assert.equal(f.getProof(), undefined)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

test('NATIVE-2 durable close and prior revocation repair a budget/finalization gap after crash', async () => {
  const f = native2Fixture(); f.closed(); f.revoked()
  await f.observe()
  assert.ok(f.calls.includes(`budget:${f.get().id}`))
  assert.ok(!f.calls.some((call) => /resolve|startTurn|createSession|attachSession|close:|revoke/.test(call)))
})

test('NATIVE-2 cold unfinalized credential gap cannot broadly revoke a replacement lifetime', async () => {
  const f = native2Fixture(); f.closed()
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

test('NATIVE-2 finalized reviewer credential is never broadly revoked by requester replay', async () => {
  const f = native2Fixture(); f.closed()
  f.interactions.coordination.workflowSession = async () => ({ session: f.session, finalized: true, reviewerActive: true })
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

function liveRequest(f: ReturnType<typeof native2Fixture>) {
  return HarnessExecutionRequestSchema.parse({ executionId: f.get().id, runId: f.run.id,
    workspaceId: f.run.workspaceId, workflowNodeId: f.get().workflowNodeId,
    workingDirectory: f.get().workingDirectory, runtimeDirectory: f.get().runtimeDirectory,
    configuration: f.configuration, input: f.get().input })
}

test('NATIVE-2 nonterminal missing permit cannot allocate a manager or silently fail the execution', async () => {
  const f = native2Fixture(false); f.set({ ...f.get(), nativeSessionId: undefined })
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'NATIVE_SESSION_START_UNCERTAIN')
  assert.ok(!f.calls.includes('resolve'))
  assert.ok(!f.calls.some((call) => call.startsWith('terminal:')))
})

test('NATIVE-2 recovery rejects a wrong exact native session before manager resolution', async () => {
  const f = native2Fixture(false)
  f.store.exactSession = async () => ({ ...f.session, nativeSessionId: 'session-other-occurrence' })
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'NATIVE_SESSION_IDENTITY_MISMATCH')
  assert.ok(!f.calls.includes('resolve'))
  assert.ok(!f.calls.some((call) => call.startsWith('terminal:')))
})

test('NATIVE-2 resident recovery observes the same turn, records terminal, closes and settles', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  const observed = await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  assert.equal(observed.state, 'completed')
  assert.ok(f.calls.includes('terminal:succeeded'))
  assert.ok(!f.calls.some((call) => /startTurn|attachSession|createSession|capabilities|respond/.test(call)))
})

test('NATIVE-2 approval receipt wait preserves native lifetime and pauses active budget', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  f.runs.updateExecution = async () => { throw new DomainError('APPROVAL_SETTLEMENT_PENDING', 'graph.resume or qualified acknowledgement pending', 409) }
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'APPROVAL_SETTLEMENT_PENDING')
  assert.ok(f.calls.includes('pause-budget'))
  assert.ok(!f.calls.some((call) => /close:|revoke:|respond|startTurn|unqualified-finalize/.test(call)))
})

test('NATIVE-2 raw provider payload keeps exact source tuple, session and continuation evidence', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  const raw = { executionId: f.get().id, connectionId: 'connection-occurrence-1', sequence: 17,
    occurredAt: f.at, type: 'native2.raw.telemetry', payload: { message: 'unaltered provider carrier', extra: { count: 9 } } }
  f.manager.reconcile = async () => ({ ...f.history(), events: [raw] })
  await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  assert.deepEqual(f.persisted[0]?.event, raw)
  assert.equal(f.persisted[0]?.owner, f.owner)
  assert.deepEqual(f.persisted[0]?.lease, { id: 'lane-native2-exact', token: 'lease-native2-exact', providerId: 'turn-native2-exact', live: false })
  assert.deepEqual(f.persisted[0]?.evidence, { session: f.session, correlationId: `execution:${f.get().id}`,
    providerId: 'turn-native2-exact', responseDeliveries: [], historyEvents: [raw] })
})

test('NATIVE-2 first launch and terminal replay use one exact session and one turn', async () => {
  const f = native2Fixture(false)
  f.set({ ...f.get(), nativeSessionId: undefined })
  let creates = 0, turns = 0, permits = 0
  f.store.consumeLaunch = () => ++permits === 1
  const physical = { ...f.manager,
    createSession: async () => { creates++; return f.session },
    startTurn: async function* (_session: unknown, input: { clientCorrelationId: string }) {
      assert.equal(input.clientCorrelationId, `execution:${f.get().id}`)
      turns++
      yield { executionId: f.get().id, connectionId: 'connection-first-occurrence', sequence: 1,
        occurredAt: f.at, type: 'native2.raw.telemetry', payload: { source: 'synthetic-native' } }
    },
  }
  f.internals.resolveManager = () => ({ manager: physical as never, processState: 'needs_start',
    beginStart: () => { f.calls.push('begin-start') }, markResident: () => { f.calls.push('resident') } })
  f.internals.prepareEnvironment = async () => {
    const owned = f.internals.ownedSessions.get(f.get().id)!
    owned.closureGeneration = '41'; owned.closureRegistration = Promise.resolve('41')
    f.internals.managerCredentials.set(physical, { principalId: 'principal-native2-captured',
      expiresAt: '2099-01-01T00:00:00.000Z', environment: { variables: {} } })
    return undefined
  }
  await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  await f.observe()
  assert.equal(creates, 1); assert.equal(turns, 1); assert.equal(permits, 1)
  assert.equal(f.get().nativeSessionId, f.session.nativeSessionId)
  assert.equal(f.calls.filter((call) => call === 'closure:41').length, 1)
})
