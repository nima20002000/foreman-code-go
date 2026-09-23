import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, HarnessNativeEventSchema, NativeSessionLaneSchema,
  type HarnessExecution } from '@graphql/contracts'
import { ExecutableWorkflowV2Schema, makeWave25Fixture, RunGraphBatchSchema,
  type RunGraphBatch, type RunGraphScope, type RunGraphSnapshot } from '@graphql/contracts/wave25'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { readCurrentGraphExchanges } from '../src/modules/interactions/wave25/currentExchanges.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { createCompactSnapshotAssembler } from '../src/modules/run-graph/compactSnapshot.js'
import { nativeGraphSource } from '../src/modules/run-graph/nativeIngestion.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { appendWorkflowNativeGraphEvent } from '../src/modules/runs/workflowNativeGraph.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { agent3Database, candidateFor, ownedAgent3, postgresEnabled, seedAgent3, setFixtureVersion,
  terminalAgent3 } from './helpers/wave25Agent3.js'

/** WR4-001: real migrated PostgreSQL, real independent Run owner/lease, actual
 * admission/failure/publication/read service and the unchanged web reducer.
 * Provider start frames and process-closure attestations are synthetic. No
 * provider binary, engine task scheduler, credential lifecycle, authenticated
 * HTTP/MCP or mounted browser is qualified by this suite. No SQL seeds a graph
 * acknowledgement, failed execution, resolution or cleanup intent.
 * agent3Database retains the explicit opt-in, loopback test DB and random schema.
 */
const resources: Array<{ db: Awaited<ReturnType<typeof agent3Database>>; owners: RunOwnership[] }> = []
afterEach(async () => {
  try {
    while (resources.length) {
      const resource = resources.pop()!
      try { await Promise.all(resource.owners.map((owner) => owner.release())) }
      finally { await resource.db.close() }
    }
  } finally { vi.restoreAllMocks() }
})

async function fixture() {
  const db = await agent3Database(), owners: RunOwnership[] = []
  resources.push({ db, owners })
  const f = makeWave25Fixture(randomUUID())
  const original = f.configurations[1]!, aNode = f.version.definition.nodes[1]!
  const configuration = AgentConfigurationVersionSchema.parse({ ...original,
    id: `${original.id}-parallel`, agentId: `${original.agentId}-parallel` })
  const bNode = { ...aNode, id: `${aNode.id}-parallel`, agentId: configuration.agentId }
  f.configurations.push(configuration)
  const version = ExecutableWorkflowV2Schema.parse({ configurations: f.configurations, version: {
    ...f.version, agentConfigurationVersionIds: { ...f.version.agentConfigurationVersionIds, [configuration.agentId]: configuration.id },
    definition: { ...f.version.definition, nodes: [...f.version.definition.nodes, bNode],
      edges: [...f.version.definition.edges, { id: `${f.scope.runId}-fork`, kind: 'execution', source: f.version.entryNodeId, target: bNode.id }],
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 } },
  } }).version
  setFixtureVersion(f, version)
  f.identities.push({ workflowNodeId: bNode.id, executionId: `${f.scope.runId}-parallel`, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1 })
  await seedAgent3(db.pool, db.directory, f)
  const { owner, store } = await ownedAgent3(db.pool, f)
  owners.push(owner)
  await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
  const root = await store.admit(f.version.entryNodeId, () => candidateFor(f))
  if (root.kind !== 'admitted') throw new Error('Expected the selected entry execution')
  // The existing helper simulates the entry's successful provider result only;
  // neither branch is directly seeded or admitted without its accepted input.
  await terminalAgent3(db.pool, store, f, root.execution)
  expect(store.consumeLaunchPermit(root.execution.id)).toBe(true)
  const resolved = await store.acceptTerminal(root.execution.id)
  expect(resolved.selectedRelationshipIds).toHaveLength(2)
  const coordination = new PostgresInteractionCoordinationRepository(db.pool)
  async function active(nodeId: string) {
    const admitted = await store.admit(nodeId, () => candidateFor(f, nodeId))
    if (admitted.kind !== 'admitted') throw new Error('Expected an actually selected branch')
    const claimed = await store.claimLaunch(admitted.execution.id, {
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, admitted.execution.id),
    })
    if (!claimed) throw new Error('Expected a committed first-launch claim')
    expect(store.consumeLaunchPermit(claimed.id)).toBe(true)
    expect(store.consumeLaunchPermit(claimed.id)).toBe(false)
    const session = { harness: 'codex' as const, providerVersion: 'synthetic-wr4-no-native-call', nativeSessionId: `native-${claimed.id}` }
    await coordination.bindWorkflowSession(claimed.id, session)
    const execution = HarnessExecutionSchema.parse({ ...claimed, nativeSessionId: session.nativeSessionId })
    await store.updateExecution(execution)
    const lane = await coordination.ensureLane(NativeSessionLaneSchema.parse({
      id: `lane-${execution.id}`, harness: 'codex', nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
      observedStatus: 'idle', connectionGeneration: 1, observedAt: new Date().toISOString(), revision: 0,
    }))
    const token = randomUUID(), providerId = `turn-${execution.id}`, correlation = `execution:${execution.id}`
    await coordination.claimLane(lane.id, lane.revision, `writer-${execution.id}`, token,
      new Date(Date.now() + 600000).toISOString(), correlation)
    await coordination.bindLaneTurn({ id: lane.id, token }, correlation)
    const lease = { id: lane.id, token, providerId, live: true }
    const event = HarnessNativeEventSchema.parse({ executionId: execution.id, connectionId: `connection-${execution.id}`,
      sequence: 0, type: 'turn.started', occurredAt: new Date().toISOString(),
      payload: { threadId: session.nativeSessionId, turnId: providerId, turn: { id: providerId, status: 'inProgress' } } })
    await appendWorkflowNativeGraphEvent(owner, event, lease)
    return { execution, event, lease, session }
  }
  const a = await active(aNode.id), b = await active(bNode.id)
  const reads = new RunGraphReadService(db.pool, createCompactSnapshotAssembler(readCurrentGraphExchanges), { qualifiedReads: true })
  const principal = { id: 'wr4-001-parity-reader', name: 'Synthetic WR4 reader', audience: 'operator' as const,
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['runs:read' as const], scope: { workspaceIds: [f.scope.workspaceId],
      workflowIds: [f.scope.workflowId], runIds: [f.scope.runId] } }] }
  const request = { protocolVersion: 1 as const, scope: f.scope }
  // Test-only dynamic import: no API production dependency on web and no web edit.
  const url = new URL('../../web/src/features/run-graph/reducer.ts', import.meta.url)
  const reducer = await import(url.href) as {
    acceptGraphSnapshot(scope: RunGraphScope, input: unknown, previous?: RunGraphSnapshot): RunGraphSnapshot
    reduceGraphPage(snapshot: RunGraphSnapshot, input: unknown): { kind: string; snapshot: RunGraphSnapshot;
      accepted: Array<{ batchId: string; sequence: string; eventIds: string[] }>; hasMore: boolean }
    graphNeedsPolling(snapshot: RunGraphSnapshot): boolean
  }
  let replayed = reducer.acceptGraphSnapshot(f.scope, await reads.snapshot(principal, request))
  for (const branch of [a, b]) {
    const node = replayed.state.nodes.find((item) => item.state.workflowNodeId === branch.execution.workflowNodeId)!
    expect(node.state.lifecycle).toBe('running')
    expect(node.activity).toMatchObject({ status: 'active', action: 'working',
      acknowledgementId: nativeGraphSource(branch.event).sourceId, correlationId: expect.any(String),
      execution: { executionId: branch.execution.id } })
  }
  expect(replayed.state.run).toMatchObject({ cleanupPending: false, stopRequested: false, executionState: 'running', outcome: 'pending' })
  // Only the immutable pre-failure snapshot initializes replay. No later snapshot
  // replaces replay, and no fact is dropped/rewritten/sorted to hide disagreement.
  async function compare() {
    const batches: RunGraphBatch[] = []
    for (;;) {
      const page = await reads.events(principal, { ...request, afterSequence: replayed.asOfSequence })
      expect(page.kind).toBe('page')
      if (page.kind !== 'page') throw new Error('Unexpected reset in bounded WR4 fixture')
      const applied = reducer.reduceGraphPage(replayed, page)
      expect(['applied', 'duplicate']).toContain(applied.kind)
      expect(applied.accepted.map((batch) => batch.eventIds).flat()).toEqual(page.batches.flatMap((batch) => batch.events.map((event) => event.eventId)))
      replayed = applied.snapshot
      const duplicate = reducer.reduceGraphPage(replayed, page)
      expect(duplicate.kind).toBe('duplicate')
      expect(duplicate.snapshot).toBe(replayed)
      batches.push(...page.batches)
      if (!page.hasMore) break
    }
    const fresh = await reads.snapshot(principal, request)
    expect(replayed).toEqual(fresh) // ALL public fields, not just A/B lifecycle.
    expect(reducer.acceptGraphSnapshot(f.scope, fresh, replayed).state).toEqual(replayed.state)
    return { snapshot: fresh, batches }
  }
  return { db, owners, f, owner, store, coordination, a, b, compare, reducer }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function nativeEvidence(f: Fixture) {
  const runId = f.f.run.id
  return {
    raw: (await f.db.pool.query(`select n.* from harness_native_events n join harness_executions e on e.id=n.execution_id
      where e.run_id=$1 order by n.execution_id,n.sequence`, [runId])).rows,
    projection: (await f.db.pool.query('select * from run_native_activity where run_id=$1 order by execution_id,work_kind,work_id', [runId])).rows,
    checkpoints: (await f.db.pool.query('select * from run_native_projection_checkpoints where run_id=$1 order by execution_id,work_kind,work_id', [runId])).rows,
    sessions: (await f.db.pool.query(`select s.* from execution_native_sessions s join harness_executions e on e.id=s.execution_id
      where e.run_id=$1 order by s.execution_id`, [runId])).rows,
    lanes: (await f.db.pool.query('select * from native_session_lanes where id=any($1::text[]) order by id', [[f.a.lease.id, f.b.lease.id]])).rows,
  }
}
async function effects(pool: pg.Pool, runId: string) {
  return (await pool.query('select * from run_graph_effects where run_id=$1 order by effect_kind,entity_id', [runId])).rows
}
async function durable(f: Fixture) {
  const id = f.f.run.id
  return {
    native: await nativeEvidence(f), effects: await effects(f.db.pool, id),
    sources: (await f.db.pool.query('select * from run_graph_sources where run_id=$1 order by source_kind,source_id,source_revision', [id])).rows,
    batches: (await f.db.pool.query('select * from run_graph_batches where run_id=$1 order by sequence', [id])).rows,
    executions: (await f.db.pool.query('select * from harness_executions where run_id=$1 order by id', [id])).rows,
    cleanup: (await f.db.pool.query('select * from run_cleanup_intents where run_id=$1', [id])).rows,
    run: (await f.db.pool.query('select * from runs where id=$1', [id])).rows,
  }
}
async function execution(f: Fixture, id: string): Promise<HarnessExecution> {
  return HarnessExecutionSchema.parse((await f.db.pool.query('select record from harness_executions where id=$1', [id])).rows[0]?.record)
}
function assertNegativeBatch(batches: RunGraphBatch[], a: HarnessExecution, b: HarnessExecution, outcome: 'failed' | 'canceled') {
  expect(batches).toHaveLength(1)
  const batch = RunGraphBatchSchema.parse(batches[0]), facts = batch.events.map((event) => event.fact)
  expect(facts.filter((fact) => fact.type === 'node.state' && fact.state.workflowNodeId === a.workflowNodeId))
    .toEqual([{ type: 'node.state', state: expect.objectContaining({ workflowNodeId: a.workflowNodeId, lifecycle: outcome }) }])
  expect(facts).toContainEqual({ type: 'node.state', state: expect.objectContaining({ workflowNodeId: b.workflowNodeId, lifecycle: 'unknown' }) })
  expect(facts).toContainEqual({ type: 'node.activity', activity: { workflowNodeId: b.workflowNodeId, status: 'none' } })
  expect(facts.filter((fact) => fact.type === 'node.resolved')).toEqual([
    { type: 'node.resolved', resolution: expect.objectContaining({ workflowNodeId: a.workflowNodeId, resolution: outcome, selectedRelationshipIds: [] }) },
  ])
  expect(facts.some((fact) => fact.type === 'worker.resumed' || fact.type === 'result.accepted' || fact.type === 'input.bound')).toBe(false)
  expect(facts.some((fact) => fact.type === 'node.activity' && fact.activity.status === 'active')).toBe(false)
  const keys = facts.map((fact) => fact.type === 'node.state' ? `${fact.type}:${fact.state.workflowNodeId}`
    : fact.type === 'node.activity' ? `${fact.type}:${fact.activity.workflowNodeId}`
      : fact.type === 'node.attention' ? `${fact.type}:${fact.attention.workflowNodeId}`
        : fact.type === 'node.resolved' ? `${fact.type}:${fact.resolution.workflowNodeId}` : fact.type)
  expect(new Set(keys).size).toBe(keys.length) // No second helper may contradict A.
}
function cleanupCoordinator(f: Fixture) {
  let confirmed = false
  const resolve = vi.fn((): never => { throw new Error('Synthetic process closure is unconfirmed; do not create a provider') })
  const closeNative = vi.fn(async () => confirmed)
  const workflows = new PostgresWorkflowRepository(f.db.pool)
  const locations = new WorkspaceLocationService(f.db.pool, new PostgresCommandCoordinator(f.db.pool))
  const runs = new PostgresRunRepository(f.db.pool, workflows, locations)
  const native = new ApprovalExecutionCoordinator(runs, new Wave25InteractionRepository(f.db.pool),
    new PostgresApprovalBudgetRepository(f.db.pool), { resolve }, 600000, undefined, undefined, closeNative)
  return { native, resolve, closeNative, confirm: () => { confirmed = true } }
}

describe.skipIf(!postgresEnabled)('WR4-001: abnormal failure publishes whole-Run cleanup at its own COMMIT', () => {
  it.each(['failed', 'canceled'] as const)('%s closes B publicly at the first failure COMMIT, without native closure or Stop', async (outcome) => {
    const f = await fixture(), before = await f.compare(), native = await nativeEvidence(f)
    const previousEffects = await effects(f.db.pool, f.f.run.id)
    const sibling = await execution(f, f.b.execution.id)
    // Actual repository return is the cut: owner transaction COMMIT completed.
    // No scheduler/cleanup task runs between this call and independent reads.
    await f.store.failExecution(f.a.execution.id, 'WR4_SELECTED_DRIVER_REJECTED', outcome === 'canceled')
    const cut = await f.compare()
    expect(cut.snapshot.asOfSequence).toBe(String(BigInt(before.snapshot.asOfSequence) + 1n))
    assertNegativeBatch(cut.batches, f.a.execution, f.b.execution, outcome)
    expect(cut.batches[0]!.events.every((event) => event.evidence.sourceKind === 'node_resolution')).toBe(true)
    expect(cut.snapshot.state.run).toMatchObject({ executionState: 'running', outcome: 'pending', stopRequested: false, cleanupPending: true })
    const b = cut.snapshot.state.nodes.find((node) => node.state.workflowNodeId === f.b.execution.workflowNodeId)!
    expect(b.state.lifecycle).toBe('unknown')
    expect(b.activity).toEqual({ workflowNodeId: f.b.execution.workflowNodeId, status: 'none' })
    expect(b.resolution).toBeUndefined()
    expect(await execution(f, f.b.execution.id)).toEqual(sibling)
    expect(await nativeEvidence(f)).toEqual(native)
    expect(f.reducer.graphNeedsPolling(cut.snapshot)).toBe(true)
    const nextEffects = await effects(f.db.pool, f.f.run.id)
    const isFailure = (row: (typeof nextEffects)[number]) => row.effect_kind === 'route.resolve' && row.entity_id === f.a.execution.workflowNodeId
    expect(nextEffects.filter(isFailure)).toHaveLength(1)
    expect(nextEffects.filter((row) => !isFailure(row))).toEqual(previousEffects)
    expect(f.store.consumeLaunchPermit(f.a.execution.id)).toBe(false)
    expect(f.store.consumeLaunchPermit(f.b.execution.id)).toBe(false)
    const committed = await durable(f)
    for (let n = 0; n < 2; n++) {
      await f.store.failExecution(f.a.execution.id, 'DO_NOT_REWRITE', outcome !== 'canceled')
      await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: true })
      expect(await durable(f)).toEqual(committed)
      expect((await f.compare()).snapshot.asOfSequence).toBe(cut.snapshot.asOfSequence)
    }
    // The BR3-001 cleanup-aware mapper remains intact: a flag cannot restore B
    // from an old native acknowledgement or bypass the unchanged source schema.
    await expect(changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: false }))
      .rejects.toMatchObject({ code: 'GRAPH_INVALID_FACT' })
    expect(await durable(f)).toEqual(committed)
    const cleanup = cleanupCoordinator(f)
    await expect(cleanup.native.cancelRun(f.f.run.id)).rejects.toBeInstanceOf(AggregateError)
    expect((await f.compare()).snapshot.asOfSequence).toBe(cut.snapshot.asOfSequence)
    expect(await nativeEvidence(f)).toEqual(native)
    expect(await execution(f, f.b.execution.id)).toEqual(sibling)
    await f.store.settleRun(outcome === 'canceled')
    const settled = await f.compare()
    expect(settled.snapshot.state.run).toMatchObject({ executionState: 'completed', outcome, stopRequested: false, cleanupPending: true })
    expect(f.reducer.graphNeedsPolling(settled.snapshot)).toBe(true)
    cleanup.confirm(); cleanup.resolve.mockClear()
    await cleanup.native.cancelRun(f.f.run.id)
    expect(cleanup.closeNative).toHaveBeenCalled()
    expect(cleanup.resolve).not.toHaveBeenCalled()
    // The lifecycle flag is cleared only after the coordinator returns confirmed
    // closure at its explicitly synthetic external port, not by failExecution.
    await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: false })
    const final = await f.compare(), finalDurable = await durable(f)
    expect(final.snapshot.state.run).toMatchObject({ executionState: 'completed', outcome, stopRequested: false, cleanupPending: false })
    expect(f.reducer.graphNeedsPolling(final.snapshot)).toBe(false)
    expect(await nativeEvidence(f)).toEqual(native)
    for (let n = 0; n < 2; n++) {
      await cleanup.native.cancelRun(f.f.run.id)
      await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: false })
      await f.store.failExecution(f.a.execution.id, 'LATE_RETRY')
      expect(await durable(f)).toEqual(finalDurable)
      expect((await f.compare()).snapshot.asOfSequence).toBe(final.snapshot.asOfSequence)
    }
    const all = (await f.db.pool.query<{ payload: unknown }>("select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id]))
      .rows.flatMap((row) => RunGraphBatchSchema.parse(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).events)
    expect(all.some((event) => event.fact.type === 'worker.resumed')).toBe(false)
    const finalEffects = await effects(f.db.pool, f.f.run.id)
    const newlyResolved = finalEffects.filter((row) => row.effect_kind === 'route.resolve'
      && [f.a.execution.workflowNodeId, f.b.execution.workflowNodeId].includes(row.entity_id))
    expect(newlyResolved).toHaveLength(2)
    expect(finalEffects.filter((row) => !newlyResolved.includes(row))).toEqual(previousEffects)
  }, 60000)

  it('retains the post-Stop negative source path without a new routing or launch effect', async () => {
    const f = await fixture()
    await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'stop' })
    const stopped = await f.compare(), previous = await effects(f.db.pool, f.f.run.id), native = await nativeEvidence(f)
    await f.store.failExecution(f.a.execution.id, 'STOPPED_EXECUTION', true)
    const cut = await f.compare()
    expect(cut.snapshot.asOfSequence).toBe(String(BigInt(stopped.snapshot.asOfSequence) + 1n))
    expect(cut.snapshot.state.run).toMatchObject({ stopRequested: true, cleanupPending: true, outcome: 'pending' })
    expect(cut.batches).toHaveLength(1)
    expect(cut.batches[0]!.events.every((event) => event.evidence.sourceKind === 'execution')).toBe(true)
    expect(cut.snapshot.state.nodes.find((node) => node.state.workflowNodeId === f.a.execution.workflowNodeId)?.state.lifecycle).toBe('canceled')
    expect(await effects(f.db.pool, f.f.run.id)).toEqual(previous)
    expect(await nativeEvidence(f)).toEqual(native)
    const saved = await durable(f)
    await f.store.failExecution(f.a.execution.id, 'REPEATED_STOP')
    await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: true })
    expect(await durable(f)).toEqual(saved)
  }, 60000)

  it('rejects a forged native lease and a released Run owner without raw, source or effect writes', async () => {
    const f = await fixture(), before = await durable(f)
    const competitor = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (competitor) f.owners.push(competitor)
    expect(competitor).toBeUndefined()
    await expect(appendWorkflowNativeGraphEvent(f.owner, { ...f.b.event, sequence: 1 },
      { ...f.b.lease, token: 'not-the-current-lease' })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    expect(await durable(f)).toEqual(before)
    await f.owner.release()
    const successor = await ownedAgent3(f.db.pool, f.f)
    f.owners.push(successor.owner)
    await expect(f.store.failExecution(f.a.execution.id, 'STALE_OWNER')).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
    expect(await durable(f)).toEqual(before)
    // Acquiring the lock is not a claim that a replacement generation recovered
    // native work. Only stale-owner rejection is qualified by this case.
  }, 60000)

  it('preserves previously saved negative and successful terminal evidence instead of overwriting it', async () => {
    const f = await fixture()
    const savedFailure = HarnessExecutionSchema.parse({ ...f.a.execution, state: 'completed', finishedAt: new Date().toISOString(),
      result: { outcome: 'failed', error: { code: 'ORIGINAL_PROVIDER_FAILURE', message: 'Original terminal evidence', retryable: false } } })
    const savedSuccess = HarnessExecutionSchema.parse({ ...f.b.execution, state: 'completed', finishedAt: new Date().toISOString(),
      result: { outcome: 'succeeded', output: { text: 'Original successful terminal' } } })
    await f.store.updateExecution(savedFailure)
    await f.store.updateExecution(savedSuccess)
    await f.compare()
    const before = await durable(f)
    await f.store.failExecution(f.b.execution.id, 'MUST_NOT_REPLACE_SUCCESS', true)
    expect(await durable(f)).toEqual(before)
    await f.store.failExecution(f.a.execution.id, 'MUST_NOT_REPLACE_FAILURE', true)
    const cut = await f.compare()
    expect(await execution(f, f.a.execution.id)).toEqual(savedFailure)
    expect(await execution(f, f.b.execution.id)).toEqual(savedSuccess)
    expect((await f.store.readResolutions()).get(f.a.execution.workflowNodeId)?.resolution).toBe('failed')
    expect((await f.store.readResolutions()).has(f.b.execution.workflowNodeId)).toBe(false)
    expect(cut.snapshot.state.run).toMatchObject({ stopRequested: false, cleanupPending: true, outcome: 'pending' })
    expect(await nativeEvidence(f)).toEqual(before.native)
  }, 60000)
})
