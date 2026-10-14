import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { SingleWriterSessionManager, SessionWriteLease } from '../src/modules/interactions/sessionWriter.js'
import { settleWorkForRestart } from '../src/modules/runs/workflowLifecycle.js'
import { openWorkflowLifecycleLocked } from '../src/modules/runs/repeatLifecycle.js'
import { canonicalRepeatEffectReceipt } from '../src/modules/run-graph/repeatEffects.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { nativeGraphSource } from '../src/modules/run-graph/nativeIngestion.js'
import { appendNormalizedNativeEvents } from '../src/modules/runs/nativeEventBatch.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { repeatDigest, repeatExecutionIdentity, repeatId, tickSlotId } from '../src/modules/runs/repeatResolution.js'
import { repeatLaunchClaim } from '../src/modules/runs/repeatNativeRepository.js'
import { reserveWorkflowNativeEntryLocked, workflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const owners: RunOwnership[] = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const owner of owners) await owner.release()
  await db?.close()
})

async function measure<T>(work: () => Promise<T>) {
  let statements = 0
  const query = pg.Client.prototype.query
  const wrapper = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args) {
    statements++
    return Reflect.apply(query, this, args)
  } as typeof query)
  const start = performance.now()
  try {
    const value = await work()
    return { value, statements, elapsedMs: performance.now() - start }
  } finally { wrapper.mockRestore() }
}

async function fixture(size: number, live = false, closed = false,
  checkPhysical?: (sql: GraphTransactionSql) => Promise<void>) {
  const base = makeCurrentWorkflowFixture(randomUUID(), 'single')
  base.version.approval = { handler: 'native' }
  base.version.definition.approval = base.version.approval
  base.version.definition.nodes[0]!.interval = { everySeconds: 10 }
  base.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 2000 }
  const f = await currentRepositoryFixture({ ...db, databaseUrl: process.env.TEST_DATABASE_URL! }, base)
  const owner = await RunOwnership.acquire(db.pool, f.f.run.id, () => {})
  if (!owner) throw new Error('Fixture Run already has an owner')
  owners.push(owner)
  const channel = createWorkflowNativeCaptureChannel()
  const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), f.locations,
    { runtimeRoot: db.directory, ...createWorkflowRepositoryServices(channel.verify, checkPhysical) })
  const scope = f.f.scope
  const { executionId: _id, ...identity } = f.f.identities[0]!
  void _id
  const executions = Array.from({ length: size }, (_, index) => HarnessExecutionSchema.parse({
    ...identity, id: `${scope.runId}-execution-${String(index).padStart(5, '0')}`, runId: scope.runId,
    state: 'queued', createdAt: f.f.createdAt,
    input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null,
      predecessors: [], tick: { index: index + 1, everySeconds: 10 } },
  }))
  const session = { harness: 'codex' as const, nativeSessionId: `session-${randomUUID()}`, providerVersion: 'fixture' }
  const execution = executions.at(-1)!
  for (const execution of closed ? executions : live ? [executions.at(-1)!] : []) {
    execution.state = 'running'
    execution.nativeSessionId = session.nativeSessionId
    execution.startedAt = execution.createdAt
    execution.workingDirectory = db.directory
    execution.runtimeDirectory = db.directory
    if (closed) {
      execution.state = 'completed'
      execution.finishedAt = execution.createdAt
      execution.result = { outcome: 'canceled' }
    }
  }
  const laneId = `lane-${randomUUID()}`
  await owner.oneShotConnection().transaction(async sql => {
    await openWorkflowLifecycleLocked(sql, scope.runId)
    const fence = await owner.readOneShotFence(sql)
    for (const item of executions) {
      const inputJson = canonicalGraphJson(item.input)
      const inputDigest = repeatDigest(item.input)
      const index = (item.input as { tick: { index: number } }).tick.index
      const slotId = tickSlotId(scope.runId, item.workflowNodeId!, index)
      await sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest,tick_index)
        values($1,$2,null,$3,$4,$5,$6)`, [slotId, scope.runId, item.workflowNodeId, inputJson, inputDigest, index])
      await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record,tick_index)
        values($1,$2,$3,$4,1,$5::jsonb,$6)`,
      [item.id, scope.runId, item.workflowNodeId, item.agentId, JSON.stringify(item), index])
      await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,technical_attempt,identity)
        values($1,$2,$3,1,$4::jsonb)`, [item.id, scope.runId, slotId, JSON.stringify(repeatExecutionIdentity(item))])
      const reservation = workflowNativeReservation(scope, { nodeId: item.workflowNodeId!, occurrence: null }, item, inputDigest)
      await reserveWorkflowNativeEntryLocked(sql, reservation)
      const digest = graphSourceDigest({ inputDigest, id: item.id })
      const receipt = canonicalRepeatEffectReceipt(scope, { kind: 'input.bind', entityId: item.id, digest })
      const semantic = graphSourceDigest({ fixture: item.id })
      await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
        values($1,'input.bind',$2,$3,$4,$5)`, [scope.runId, item.id, digest, fence.ownerId, fence.fence])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,$2,$3,1,$4,$5,1)`,
      [scope.runId, receipt.evidence.sourceKind, receipt.evidence.sourceId, receipt.sourceDigest, semantic])
      await sql.query(`insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
        values($1,'input.bind',$2,$3,$4,1)`, [scope.runId, receipt.effect!.entityId, digest, semantic])
      if (!closed && (item !== execution || !live)) continue
      const transition = { reservation, phase: 'entered', ownerId: fence.ownerId, ownerFence: fence.fence, launchDigest: digest }
      const sourceId = `entry-${item.id}`
      const sourceDigest = repeatDigest(transition)
      await sql.query(`update workflow_native_entries set phase='prepared',transition=$2::jsonb,source_id=$3,source_digest=$4
        where execution_id=$1`, [item.id, JSON.stringify({ ...transition, phase: 'prepared' }), sourceId, sourceDigest])
      await sql.query(`update workflow_native_entries set phase='entered',transition=$2::jsonb,source_id=$3,source_digest=$4
        where execution_id=$1`, [item.id, JSON.stringify(transition), sourceId, sourceDigest])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'execution',$2,1,$3,$4,1)`, [scope.runId, sourceId, sourceDigest, semantic])
      await sql.query(`insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)`,
        [item.id, JSON.stringify(session)])
      const pins = { id: item.id, runId: item.runId, workflowNodeId: item.workflowNodeId,
        agentId: item.agentId, agentConfigurationVersionId: item.agentConfigurationVersionId,
        attempt: item.attempt, workingDirectory: item.workingDirectory, runtimeDirectory: item.runtimeDirectory }
      await sql.query(`insert into execution_native_closures(execution_id,execution_identity,expected_reference,closed_reference,closed_at)
        values($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::timestamptz)`,
      [item.id, JSON.stringify(pins), JSON.stringify(session), closed ? JSON.stringify(session) : null,
        closed ? item.finishedAt : null])
      const launchDigest = repeatDigest(repeatLaunchClaim(scope, { nodeId: item.workflowNodeId!, occurrence: null }, item, inputDigest))
      await sql.query(`insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
        values($1,'execution.launch',$2,$3,$4,1)`, [scope.runId, item.id, launchDigest, semantic])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'execution',$2,1,$3,$4,1)`, [scope.runId,
        repeatId('repeat-native', scope.runId, 'outside', item.id, 'launch', launchDigest), launchDigest, semantic])
      if (item !== execution || !live) continue
      await sql.query(`insert into native_session_lanes(id,harness,native_session_id,owner_agent_id,record)
        values($1,'codex',$2,$3,$4::jsonb)`, [laneId, session.nativeSessionId, item.agentId, JSON.stringify({
        connectionGeneration: 1, leaseToken: 'token', leaseOwner: 'fixture',
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        correlationId: `execution:${item.id}`, currentTurnOrMessageId: 'turn',
      })])
      await sql.query(`insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
        correlation_key,provider,native_session_id,connection_id,connection_generation,native_turn_id,
        first_native_sequence,last_native_sequence,metadata_revision)
        values($1,$2,$3,1,'workflow',$2,$4,'codex',$5,'connection',1,'turn',0,0,0)`,
      [scope.runId, item.id, item.workflowNodeId, `execution:${item.id}`, session.nativeSessionId])

    }
  })
  const generation = live ? (await db.pool.query<{ generation: string }>(
    'select generation::text from execution_native_closures where execution_id=$1', [execution.id])).rows[0]!.generation : null
  const manager = { harness: 'codex', assertCapturedLease() {} } as unknown as SingleWriterSessionManager
  const lease = { fence: { id: laneId, token: 'token' }, previous: { connectionGeneration: 1 }, providerId: 'turn' } as SessionWriteLease
  const capture = (source: Parameters<typeof channel.capture.capture>[0]['source']) => channel.capture.capture({
    owner, execution, session, manager, lease, lifetimeGeneration: 1, closureGeneration: generation,
    kind: 'live', source, assertCurrent() {},
  })
  const event = (sequence: number): HarnessNativeEvent => ({ executionId: execution.id, connectionId: 'connection',
    sequence, type: 'native.notification', occurredAt: execution.createdAt,
    payload: { nativeMethod: 'item/agentMessage/delta', text: `frame ${sequence}` } })
  const read = async () => ({
    executions: (await db.pool.query('select record from harness_executions where run_id=$1 order by id', [scope.runId])).rows,
    events: (await db.pool.query('select record from harness_native_events where execution_id=$1 order by sequence', [execution.id])).rows,
    activities: (await db.pool.query('select kind,payload from run_activity where run_id=$1 order by sequence', [scope.runId])).rows,
  })
  return { ...f, owner, repository, scope, execution, executions, session, lease, capture, event, read }
}

it('appends transcript batches in a constant number of statements and preserves replay and conflict behavior', async () => {
  const f = await fixture(80, true)
  const frames = Array.from({ length: 16 }, (_, index) => {
    const event = f.event(index)
    return { event, evidence: f.capture({ type: 'event', event }) }
  })
  const first = await measure(() => f.repository.appendNativeEvents(frames.slice(0, 1), f.owner, { ...f.lease.fence, live: true, providerId: 'turn' }))
  const batch = await measure(() => f.repository.appendNativeEvents(frames, f.owner, { ...f.lease.fence, live: true, providerId: 'turn' }))
  const saved = await f.read()
  expect(saved.events).toEqual(frames.map(({ event }) => ({ record: event })))
  expect(saved.executions).toEqual(f.executions.map(record => ({ record })))
  await f.repository.appendNativeEvents(frames, f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })
  expect(await f.read()).toEqual(saved)
  const changed = { ...frames[2]!.event, payload: { different: true } }
  await expect(f.repository.appendNativeEvents([{ event: changed, evidence: f.capture({ type: 'event', event: changed }) }],
    f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })).rejects.toMatchObject({ code: 'NATIVE_SOURCE_CONFLICT' })
  expect(await f.read()).toEqual(saved)
  console.info('appendNativeEvents', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(100)
})

it('replays retained semantic history with constant statement count and unchanged persisted events', async () => {
  const f = await fixture(80, true)
  const events = Array.from({ length: 400 }, (_, sequence) => ({ ...f.event(sequence), type: 'turn.started',
    payload: { threadId: f.session.nativeSessionId, turn: { id: 'turn', status: 'inProgress' } } }))
  await f.owner.oneShotConnection().transaction(async sql => {
    for (const event of events) {
      await appendNativeEvent(sql, event)
      const source = nativeGraphSource(event)
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'native_event',$2,0,$3,$4,1)`,
      [f.scope.runId, source.sourceId, graphSourceDigest(event), graphSourceDigest({ fixture: event.sequence })])
    }
  })
  // The provider's exact terminal frame is already retained, like the live stream before its history read.
  const terminal = { ...f.event(400), type: 'turn.completed', payload: { threadId: f.session.nativeSessionId,
    turn: { id: 'turn', status: 'failed' } } }
  await appendNativeEvent(db.pool, terminal)
  await db.pool.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
    values($1,'native_event',$2,0,$3,$4,1)`,
  [f.scope.runId, nativeGraphSource(terminal).sourceId, graphSourceDigest(terminal), graphSourceDigest({ fixture: 'terminal' })])
  const history = { correlationId: `execution:${f.execution.id}`, nativeTurnId: 'turn',
    events: [...events, terminal], pendingInteractions: [], terminalTurn: {
      correlationId: `execution:${f.execution.id}`, providerId: 'turn', result: { outcome: 'failed' as const,
        error: { code: 'FIXTURE_FAILED', message: 'Fixture terminal', retryable: false } },
    } }
  const evidence = f.capture({ type: 'history', history })
  const incoming = HarnessExecutionSchema.parse({ ...f.execution, state: 'completed', result: history.terminalTurn.result,
    finishedAt: channelObservedAt(evidence) })
  const before = await f.read()
  const measured = await measure(() => f.repository.updateExecution(incoming, f.owner, evidence))
  const after = await f.read()
  expect(after.events).toEqual(before.events)
  expect(after.executions).toEqual(before.executions.map(row => row.record.id === incoming.id ? { record: incoming } : row))
  console.info('updateExecution', measured)
  expect(measured.statements).toBeLessThanOrEqual(160)
})

function channelObservedAt(evidence: ReturnType<ReturnType<typeof createWorkflowNativeCaptureChannel>['capture']['capture']>): string {
  return (evidence.evidence as { observedAt: string }).observedAt
}

it('retains many unsubmitted executions across restart with constant statement count and identical persisted state', async () => {
  const small = await fixture(1)
  const large = await fixture(80)
  const before = await large.read()
  const first = await measure(() => settleWorkForRestart(small.owner))
  const batch = await measure(() => settleWorkForRestart(large.owner))
  expect(first.value).toBe(true)
  expect(batch.value).toBe(true)
  expect(await large.read()).toEqual(before)
  console.info('settleWorkForRestart', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(100)
})

it('settles many closed native attempts across restart without per-attempt queries', async () => {
  const small = await fixture(1, false, true)
  const large = await fixture(80, false, true)
  const before = await large.read()
  const first = await measure(() => settleWorkForRestart(small.owner))
  const batch = await measure(() => settleWorkForRestart(large.owner))
  expect(first.value).toBe(true)
  expect(batch.value).toBe(true)
  expect(await large.read()).toEqual(before)
  expect((await db.pool.query('select execution_id from execution_native_sessions where workflow_finalized_at is not null and execution_id=any($1::text[])',
    [large.executions.map(item => item.id)])).rowCount).toBe(80)
  console.info('settleClosedWorkForRestart', batch)
  expect(batch.statements).toBeLessThanOrEqual(first.statements + 2)
  expect(batch.statements).toBeLessThanOrEqual(100)
})

it('matches single-event allocation, replay, activity filtering and absorbing rejection across a mixed batch', async () => {
  const f = await fixture(2)
  const source = f.executions[0]!
  const target = f.executions[1]!
  const first = { ...f.event(5), executionId: source.id, payload: { text: 'visible' } }
  const disconnected = { executionId: source.id, sequence: 10, type: 'native.notification',
    occurredAt: source.createdAt, payload: { text: 'unconnected' } }
  const other = { ...first, connectionId: 'other-connection', sequence: 7 }
  const rejected = { ...first, sequence: 8, payload: null } as unknown as HarnessNativeEvent
  const absorbed = { ...first, sequence: 8, payload: { text: 'bounded later replay' } }
  const frames = [first, disconnected, other, first, f.event(9), rejected, absorbed]
    .map(event => ({ ...event, executionId: source.id }))
  for (const event of frames) await appendNativeEvent(db.pool, event)
  const batch = frames.map(event => normalizeNativeProducerEvent({ ...event, executionId: target.id }))
  const measured = await measure(() => f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, batch)))
  expect(measured.value.map(item => [item.inserted, item.rejected, item.sequence])).toEqual([
    [true, false, '0'], [true, false, '10'], [true, false, '11'], [false, false, '0'],
    [true, false, '12'], [true, true, '13'], [false, true, '13'],
  ])
  const saved = async (id: string) => ({
    events: (await db.pool.query('select record,connection_id,source_sequence from harness_native_events where execution_id=$1 order by sequence', [id]))
      .rows.map(row => ({ ...row, record: { ...row.record, executionId: 'execution' } })),
    activities: (await db.pool.query('select kind,payload from run_activity where harness_execution_id=$1 order by sequence', [id])).rows,
    allocator: (await db.pool.query('select native_event_next_sequence::text from harness_executions where id=$1', [id])).rows,
  })
  const original = await saved(source.id)
  expect(await saved(target.id)).toEqual(original)
  await f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, batch))
  expect(await saved(target.id)).toEqual(original)
  await expect(f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, [
    normalizeNativeProducerEvent({ ...f.event(100), executionId: target.id }),
    normalizeNativeProducerEvent({ ...first, executionId: target.id, payload: { conflicting: true } }),
  ]))).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  expect(await saved(target.id)).toEqual(original)
  // An unconnected identity cannot adopt a connected rejection at the same stored position.
  await expect(f.owner.oneShotConnection().transaction(sql => appendNormalizedNativeEvents(sql, [
    normalizeNativeProducerEvent({ ...disconnected, executionId: target.id, sequence: 13 }),
  ]))).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  expect(await saved(target.id)).toEqual(original)
  expect(measured.statements).toBeLessThanOrEqual(5)
})

it('rolls a native batch back when its writer lane changes before commit', async () => {
  let changed = false
  const f = await fixture(1, true, false, async sql => {
    if (changed) return
    changed = true
    beforeGraphCommit(sql, async () => {
      await sql.query("update native_session_lanes set record=jsonb_set(record,'{leaseToken}',$2::jsonb) where id=$1",
        [f.lease.fence.id, JSON.stringify('replaced')])
    })
  })
  const before = await f.read()
  const event = f.event(1)
  await expect(f.repository.appendNativeEvents([{ event, evidence: f.capture({ type: 'event', event }) }],
    f.owner, { ...f.lease.fence, live: true, providerId: 'turn' })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(await f.read()).toEqual(before)
  expect((await db.pool.query('select proof_id from workflow_native_proofs where execution_id=$1', [f.execution.id])).rowCount).toBe(0)
  expect((await db.pool.query("select record->>'leaseToken' as token from native_session_lanes where id=$1",
    [f.lease.fence.id])).rows).toEqual([{ token: 'token' }])
})
