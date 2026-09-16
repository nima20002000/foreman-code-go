import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { DurableInteractionSchema, type DurableInteraction, type HarnessNativeEvent } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'
import { it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import { assertDeliveryLease, type LockedInteraction } from '../src/modules/interactions/persistence.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

function interaction(): DurableInteraction {
  return DurableInteractionSchema.parse({
    id: 'interaction-1', revision: 0, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: 'run-1', executionId: 'execution-1', requestingAgentId: 'agent-1',
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-session-1',
    nativeRequestId: 'native-request-1', nativeRequestType: 'approval', graphThreadId: 'thread-1',
    graphInterruptId: 'interrupt-1', request: { command: ['echo', 'test'] }, approval: { handler: 'operator' },
    responseOptions: [{ optionId: 'opaque-option-1', semantic: 'approve_once', label: 'Approve once',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  })
}

const principal: ManagementPrincipal = {
  id: 'operator-1', name: 'Operator', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['interactions:respond'], scope: { workspaceIds: ['workspace-1'] } }],
}
const response = { interactionId: 'interaction-1', optionId: 'opaque-option-1', expectedRevision: 0, commandId: 'command-0001' }

/** Models transaction rollback, not PostgreSQL locking; concurrency is covered by the integration suite. */
class DecisionStore {
  record: DurableInteraction | undefined = interaction()
  receipts = new Map<string, { interaction_id: string; option_id: string }>()
  queries: string[] = []
  updates = 0
  released = 0
  failUpdate = false
  private snapshot: { record: DurableInteraction | undefined; receipts: Map<string, { interaction_id: string; option_id: string }> } | undefined

  readonly pool = {
    connect: async () => ({ query: this.query.bind(this), release: () => { this.released += 1 } }),
    query: this.query.bind(this),
  } as unknown as pg.Pool

  async query(sql: string, values: unknown[] = []) {
    this.queries.push(sql)
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount })
    if (sql === 'begin') { this.snapshot = structuredClone({ record: this.record, receipts: this.receipts }); return result() }
    if (sql === 'rollback') {
      assert.ok(this.snapshot)
      this.record = this.snapshot.record; this.receipts = this.snapshot.receipts
      return result()
    }
    if (sql === 'commit') return result()
    if (sql.startsWith('select record')) return result(this.record ? [{ record: this.record, delivery_fence: '0', delivery_owner: null, delivery_token: null, lease_active: false }] : [])
    if (sql.startsWith('insert into interaction_command_receipts')) {
      const key = `${values[0]}:${values[1]}`
      if (this.receipts.has(key)) return result([], 0)
      this.receipts.set(key, { interaction_id: String(values[2]), option_id: String(values[3]) })
      return result([], 1)
    }
    if (sql.startsWith('select interaction_id,option_id')) {
      const receipt = this.receipts.get(`${values[0]}:${values[1]}`)
      return result(receipt ? [receipt] : [])
    }
    if (sql.startsWith('update interaction_command_receipts')) return result([], 1)
    if (sql.startsWith('update durable_interactions set status=')) {
      if (this.failUpdate) throw new Error('database write failed')
      this.record = JSON.parse(String(values[3])) as DurableInteraction
      this.updates += 1
      return result([], 1)
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
}

function decide(store: DecisionStore, overrides: Partial<Parameters<PostgresInteractionRepository['decide']>[0]> = {}) {
  return new PostgresInteractionRepository(store.pool).decide({
    id: response.interactionId, optionId: response.optionId, expectedRevision: 0,
    nativeResponse: { optionId: response.optionId }, command: { principal, commandId: response.commandId }, ...overrides,
  })
}

it('resolves and authorizes the exact Operator target before calling the decision service', async () => {
  for (const kind of ['missing', 'wrong-handler', 'wrong-scope', 'expired', 'revoked', 'worker'] as const) {
    const store = new DecisionStore()
    if (kind === 'missing') store.record = undefined
    if (kind === 'wrong-handler') store.record!.approval = { handler: 'user' }
    let calls = 0
    const service = { respond: async () => { calls += 1; throw new Error('must not dispatch') } } as unknown as InteractionService
    const caller = kind === 'wrong-scope' ? { ...principal, grants: [{ actions: ['interactions:respond' as const], scope: { workspaceIds: ['other'] } }] }
      : kind === 'expired' ? { ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }
        : kind === 'revoked' ? { ...principal, revokedAt: '2026-01-01T00:00:00.000Z' }
          : kind === 'worker' ? { ...principal, audience: 'worker' as const, agentId: 'agent-1' } : principal
    await assert.rejects(new OperatorInteractionService(service, new PostgresInteractionRepository(store.pool)).respond(caller, response))
    assert.equal(calls, 0, kind)
    assert.equal(store.receipts.size, 0, kind)
    assert.equal(store.queries.some((sql) => sql.startsWith('insert')), false, kind)
  }
})

it('reauthorizes inside the locked decision transaction before receipt insertion', async () => {
  const store = new DecisionStore()
  await assert.rejects(decide(store, { command: { principal: { ...principal, grants: [] }, commandId: response.commandId } }), { code: 'ACCESS_DENIED' })
  assert.equal(store.receipts.size, 0)
  assert.equal(store.queries.some((sql) => sql.startsWith('insert')), false)
  assert.equal(store.queries.at(-1), 'rollback')
  assert.equal(store.released, 1)
})

it('does not bind receipts for missing, stale, invalid-option or canceled decisions', async () => {
  for (const kind of ['missing', 'stale', 'option', 'canceled'] as const) {
    const store = new DecisionStore()
    if (kind === 'missing') store.record = undefined
    if (kind === 'canceled') store.record!.status = 'canceled'
    await assert.rejects(decide(store, kind === 'stale' ? { expectedRevision: 10 } : kind === 'option' ? { optionId: 'forged' } : {}))
    assert.equal(store.receipts.size, 0, kind)
    assert.equal(store.updates, 0, kind)
  }
})

it('rolls the command receipt back when the decision update fails', async () => {
  const store = new DecisionStore()
  store.failUpdate = true
  await assert.rejects(decide(store), /database write failed/)
  assert.equal(store.receipts.size, 0)
  assert.equal(store.record!.status, 'pending')
  assert.equal(store.queries.at(-1), 'rollback')
})

it('replays the same authorized command without creating another decision', async () => {
  const store = new DecisionStore()
  assert.equal((await decide(store)).replayed, false)
  assert.equal((await decide(store)).replayed, true)
  assert.equal(store.receipts.size, 1)
  assert.equal(store.updates, 1)
  assert.equal(store.record!.nativeSessionId, interaction().nativeSessionId)
  assert.equal(store.record!.nativeRequestId, interaction().nativeRequestId)
  await assert.rejects(decide(store, { command: { principal: { ...principal, grants: [] }, commandId: response.commandId } }), { code: 'ACCESS_DENIED' })
  assert.equal(store.updates, 1)
})

it('rejects reuse of a command for another target and rolls back its decision', async () => {
  const store = new DecisionStore()
  store.receipts.set(`${principal.id}:${response.commandId}`, { interaction_id: 'other-interaction', option_id: response.optionId })
  await assert.rejects(decide(store), { code: 'COMMAND_ID_REUSED' })
  assert.equal(store.record!.status, 'pending')
  assert.equal(store.updates, 0)
})

it('never allows an unfenced, expired, or superseded worker to write a claimed delivery', () => {
  const lease = { owner: 'worker-1', token: 'token-1', fence: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
  const row: LockedInteraction = { interaction: interaction(), fence: 1, owner: lease.owner, token: lease.token, leaseActive: true }
  assertDeliveryLease(row, lease)
  assert.throws(() => assertDeliveryLease(row), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease(row, { ...lease, fence: 0 }), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease({ ...row, leaseActive: false }, lease), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease({ ...row, owner: null, token: null, leaseActive: false }), { code: 'DELIVERY_LEASE_LOST' })
})

it('does not reopen a delivered, failed, or canceled native response', async () => {
  for (const state of ['delivered', 'failed', 'canceled'] as const) {
    const store = new DecisionStore()
    await decide(store)
    store.record = { ...store.record!, deliveryState: state === 'canceled' ? 'submitted' : state,
      status: state === 'failed' ? 'delivery_failed' : state }
    await assert.rejects(new PostgresInteractionRepository(store.pool).updateDelivery(store.record.id, store.record.revision, 'submitted'))
    assert.equal(store.updates, 1)
  }
})

it('stores native event envelopes and their activity references atomically, with exact replay only', async () => {
  const events = new Map<number, unknown>()
  let activityCount = 0
  const db = { query: async (sql: string, values: unknown[]) => {
    const sequence = Number(values[1]); const record: unknown = JSON.parse(String(values[2]))
    if (sql.startsWith('with appended')) {
      assert.match(sql, /insert into harness_native_events/)
      assert.match(sql, /insert into run_activity/)
      if (events.has(sequence)) return { rows: [], rowCount: 0 }
      events.set(sequence, record); activityCount += 1
      return { rows: [], rowCount: 1 }
    }
    return { rows: [{ matches: JSON.stringify(events.get(sequence)) === JSON.stringify(record) }], rowCount: 1 }
  } } as unknown as pg.ClientBase
  const event: HarnessNativeEvent = { executionId: 'execution-1', sequence: 7, type: 'native.approval', occurredAt: '2026-09-16T00:00:00.000Z', payload: { requestId: 'exact-native-request', nested: { value: true } } }
  await appendNativeEvent(db, event)
  await appendNativeEvent(db, event)
  assert.equal(activityCount, 1)
  assert.deepEqual(events.get(7), event)
  await assert.rejects(appendNativeEvent(db, { ...event, payload: { requestId: 'another-request' } }), { code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  assert.deepEqual(events.get(7), event)
})

function deliveryService(attachError?: Error, graphError?: Error) {
  const base = interaction()
  const decided = { ...base, revision: 1, status: 'delivery_pending' as const, deliveryState: 'pending' as const, selectedOptionId: response.optionId }
  const transitions: Array<{ state: string; options: unknown }> = []
  const attempts: string[] = []
  const repository = {
    get: async () => base,
    decide: async () => ({ interaction: decided, replayed: false }),
    updateDelivery: async (_id: string, revision: number, state: string, options?: unknown) => {
      transitions.push({ state, options })
      return { ...decided, revision: revision + 1, deliveryState: state }
    },
    beginDeliveryAttempt: async () => 1,
    finishDeliveryAttempt: async (_id: string, _attempt: number, state: string) => { attempts.push(state) },
  } as unknown as PostgresInteractionRepository
  const budgets = { assertActive: async () => undefined, resume: async () => undefined } as unknown as PostgresApprovalBudgetRepository
  const runtime = { attachInteraction: async () => {
    if (attachError) throw attachError
    return { manager: { respond: async () => undefined }, session: { nativeSessionId: base.nativeSessionId } }
  } } as unknown as InteractionNativeRuntime
  const service = new InteractionService(repository, budgets, runtime, async () => { if (graphError) throw graphError })
  return { service, transitions, attempts }
}

it('keeps attachment failure details instead of persisting an unexplained failed flag', async () => {
  const { service, transitions, attempts } = deliveryService(new Error('native session is unavailable'))
  await service.respond({ kind: 'operator', principal }, response)
  assert.deepEqual(transitions, [{ state: 'failed', options: { error: {
    code: 'NATIVE_ATTACHMENT_FAILED', message: 'native session is unavailable', phase: 'attach', certainty: 'definite',
  } } }])
  assert.deepEqual(attempts, [])
})

it('does not relabel delivered native work as failed when graph resume throws', async () => {
  const { service, transitions, attempts } = deliveryService(undefined, new Error('checkpoint unavailable'))
  await assert.rejects(service.respond({ kind: 'operator', principal }, response), /checkpoint unavailable/)
  assert.deepEqual(attempts, ['delivered'])
  assert.deepEqual(transitions.map((item) => item.state), ['submitted', 'delivered'])
})

it('keeps every applied migration byte-for-byte and adds only HAP-05 migration 503', async () => {
  // SHA-256 of each SQL string at PR #10 audited head 2f83f40b.
  const expected: Record<number, string> = {
    "1": "51b2b3e95b480d1abd6139242182c4e39e9730ab5f1d1ca10b84500005e81510",
    "2": "6da1fab50bd4fde4520784404a280c9497076d3b3c018f5dc1bed0e78d12d749",
    "3": "2b545955f4e9c217304b231b2f852643a605c7e7ef2c6c29e19b7b70abd449fd",
    "4": "bc06d634bcb6a171a9197e455ec53b9b1f917bfa32385e948a6e4bddcd5ed735",
    "100": "6d469df7996be70dda86c1c418e7b8f1a0298553f40e59f3f41a45a8f483adc2",
    "400": "a6c04743b1976775bc7288d22f82d8ace78b9d5eb584c003c29d9711f6374dfa",
    "500": "6a43e990d882be17801de27a818c213afc868abfd56d46279b28f26827860282",
    "501": "f4f20e80724b114d4aac79a6954b9ad3038505a87bd6bed8c62fb01c471baaa6",
    "502": "dc69bad80b05933123fe9d7eedfe8feafc06404b0abaa7c615da179e7a6a46e7"
}
  const observed = new Map<number, string>()
  let lastSql = ''
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('insert into application_migrations')) observed.set(Number(values[0]), createHash('sha256').update(lastSql).digest('hex'))
    else lastSql = sql
    return { rows: [], rowCount: 0 }
  } }) } as unknown as pg.Pool
  await applyApplicationMigrations(pool)
  assert.deepEqual([...observed.keys()], [...Object.keys(expected).map(Number), 503])
  for (const [version, hash] of Object.entries(expected)) assert.equal(observed.get(Number(version)), hash, `migration ${version}`)
})
