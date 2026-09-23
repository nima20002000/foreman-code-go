import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { NodeResolutionSchema, RunGraphBatchSchema } from '@graphql/contracts/wave25'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { OneShotRunRepository } from '../src/modules/runs/oneShotPostgres.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import {
  agent3Database, seedAgent3, ownedAgent3, candidateFor, terminalAgent3, graphHead, deferred, postgresEnabled,
  type Agent3Fixture,
} from './helpers/wave25Agent3.js'

/** Real transactions, real independent sessions, real constraints/finalizers.
 * Fault triggers simulate a crash before COMMIT; a transport shim below loses
 * only the COMMIT response after PostgreSQL has actually committed. */
describe.skipIf(!postgresEnabled)('Agent 3 one-shot crash/race PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const owners: RunOwnership[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => {
    vi.restoreAllMocks()
    while (owners.length) await owners.pop()!.release()
    for (const table of ['runs', 'harness_executions', 'run_node_resolutions', 'run_input_bindings', 'run_graph_batches']) {
      await db.pool.query(`drop trigger if exists a3_test_fault on ${table}`)
    }
  })
  afterAll(async () => { await db?.close() })

  async function fresh() {
    const fixture = await seedAgent3(db.pool, db.directory)
    const { owner, store } = await ownedAgent3(db.pool, fixture)
    owners.push(owner)
    return { fixture, owner, store }
  }
  async function admit(store: OneShotRunRepository, fixture: Agent3Fixture, node = fixture.version.entryNodeId) {
    const admitted = await store.admit(node, () => candidateFor(fixture, node))
    if (admitted.kind !== 'admitted') throw new Error('Expected synthetic queue admission')
    return admitted.execution
  }
  async function fault(table: 'runs' | 'harness_executions' | 'run_node_resolutions' | 'run_input_bindings' | 'run_graph_batches') {
    await db.pool.query(`create or replace function a3_test_crash() returns trigger language plpgsql as $$
      begin raise exception 'A3_CRASH_BEFORE_COMMIT'; end $$`)
    await db.pool.query(`create trigger a3_test_fault after insert on ${table} for each row execute function a3_test_crash()`)
    return () => db.pool.query(`drop trigger a3_test_fault on ${table}`)
  }
  async function blocked(owner: RunOwnership) {
    const pid = Number((await db.pool.query<{ pid: number }>(
      "select pid from pg_stat_activity where application_name='graphql-run-owner' and pid in (select pid from pg_locks where locktype='advisory' and objid=(hashtext($1)::bigint & 4294967295)::oid)",
      [owner.runId])).rows[0]!.pid)
    for (let i = 0; i < 100; i++) {
      const row = (await db.pool.query<{ ids: number[] }>('select pg_blocking_pids($1) as ids', [pid])).rows[0]!
      if (row.ids.length) return
      await delay(10)
    }
    throw new Error('Expected an independently blocked Run-owner transaction')
  }
  async function stopHoldingLock(fixture: Agent3Fixture) {
    const entered = deferred(), release = deferred()
    const task = changeOneShotLifecycle(db.pool, fixture.run.id, { kind: 'stop', authorize: async () => {
      // Test-only latch at an already-held Run lock. Production authorization is SQL-only.
      entered.resolve(); await release.promise
    } })
    await entered.promise
    return { task, release }
  }

  it.each(['harness_executions', 'run_input_bindings', 'run_graph_batches'] as const)(
    'queue and exact receipts roll back together when %s fails', async (table) => {
      const { fixture, store } = await fresh()
      const sender = await admit(store, fixture)
      await terminalAgent3(db.pool, store, fixture, sender)
      await store.acceptTerminal(sender.id)
      const head = await graphHead(db.pool, fixture.run.id)
      const remove = await fault(table)
      const recipientNode = fixture.identities[1]!.workflowNodeId
      await expect(admit(store, fixture, recipientNode)).rejects.toThrow(
        table === 'run_graph_batches' ? 'A3_CRASH_BEFORE_COMMIT' : 'GRAPH_INVALID_FACT')
      expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
      expect((await db.pool.query('select 1 from harness_executions where id=$1', [fixture.identities[1]!.executionId])).rowCount).toBe(0)
      expect((await db.pool.query('select 1 from run_input_bindings where run_id=$1', [fixture.run.id])).rowCount).toBe(0)
      await remove()
      const receiver = await admit(store, fixture, recipientNode)
      const again = await store.admit(recipientNode, () => { throw new Error('Must not create another attempt') })
      expect(again).toMatchObject({ kind: 'admitted', reused: true, execution: { id: receiver.id } })
      expect((await db.pool.query('select 1 from run_input_bindings where run_id=$1', [fixture.run.id])).rowCount).toBe(1)
      expect(receiver).not.toHaveProperty('nativeSessionId')
      expect(receiver).not.toHaveProperty('runtimeDirectory')
    })

  it.each(['run_node_resolutions', 'run_graph_batches'] as const)(
    'successful result, route and publication remain atomic across %s failure', async (table) => {
      const { fixture, store, owner } = await fresh()
      const execution = await admit(store, fixture)
      await terminalAgent3(db.pool, store, fixture, execution, { evidence: 'private-result-body' })
      const head = await graphHead(db.pool, fixture.run.id)
      const remove = await fault(table)
      await expect(store.acceptTerminal(execution.id)).rejects.toThrow(
        table === 'run_graph_batches' ? 'A3_CRASH_BEFORE_COMMIT' : 'GRAPH_INVALID_FACT')
      expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
      expect((await db.pool.query<{ accepted: boolean }>('select accepted from harness_executions where id=$1', [execution.id])).rows[0]!.accepted).toBe(false)
      expect((await db.pool.query('select 1 from run_node_resolutions where run_id=$1', [fixture.run.id])).rowCount).toBe(0)
      expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind in ('result.accept','route.resolve')", [fixture.run.id])).rowCount).toBe(0)
      await remove()
      // A process loss before checkpoint commit cannot repeat the predecessor.
      await owner.release()
      const recovered = await ownedAgent3(db.pool, fixture); owners.push(recovered.owner)
      const same = await recovered.store.admit(fixture.version.entryNodeId, () => { throw new Error('No new native candidate') })
      expect(same).toMatchObject({ kind: 'admitted', reused: true, execution: { id: execution.id, state: 'completed' } })
      const resolved = await recovered.store.acceptTerminal(execution.id)
      const committed = await graphHead(db.pool, fixture.run.id)
      expect(await recovered.store.acceptTerminal(execution.id)).toEqual(resolved)
      expect(await graphHead(db.pool, fixture.run.id)).toBe(committed)
      const body = (await db.pool.query<{ payload: string }>('select payload from run_graph_batches where run_id=$1 and sequence=$2::bigint', [fixture.run.id, committed])).rows[0]!.payload
      const batch = RunGraphBatchSchema.parse(JSON.parse(body))
      expect(batch.events.map((event) => event.fact.type)).toEqual(['result.accepted', 'node.resolved', 'node.state'])
      expect(body).not.toContain('private-result-body')
    })

  it('reuses a committed route after checkpoint loss, without another candidate, result or cursor', async () => {
    const { fixture, store, owner } = await fresh()
    const execution = await admit(store, fixture)
    await terminalAgent3(db.pool, store, fixture, execution)
    const resolution = await store.acceptTerminal(execution.id)
    const head = await graphHead(db.pool, fixture.run.id)
    await owner.release()
    const recovered = await ownedAgent3(db.pool, fixture); owners.push(recovered.owner)
    expect(await recovered.store.admit(fixture.version.entryNodeId, () => { throw new Error('No relaunch') })).toEqual({ kind: 'resolved', resolution })
    expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
  })

  it('treats reordered JSON object keys as the same immutable input, but rejects changed values', async () => {
    const { fixture, store } = await fresh()
    const execution = await admit(store, fixture)
    const claimed = await store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/not-created` })
    if (!claimed) throw new Error('Expected a first-launch claim')
    const reordered = Object.fromEntries(Object.entries(claimed.input as Record<string, unknown>).reverse())
    await expect(store.updateExecution({ ...claimed, input: reordered as typeof claimed.input })).resolves.toBeUndefined()
    await expect(store.updateExecution({ ...claimed, input: { ...reordered, changed: true } as typeof claimed.input })).rejects.toMatchObject({ code: 'EXECUTION_OCCURRENCE_CONFLICT' })
  })

  it('does not reissue first-launch permission after a crash with no session acknowledgement', async () => {
    const { fixture, store, owner } = await fresh()
    const execution = await admit(store, fixture)
    const paths = { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/not-created` }
    expect(await store.claimLaunch(execution.id, paths)).toMatchObject({ state: 'starting' })
    await owner.release()
    const recovered = await ownedAgent3(db.pool, fixture); owners.push(recovered.owner)
    expect(await recovered.store.claimLaunch(execution.id, paths)).toBeUndefined()
    expect(recovered.store.consumeLaunchPermit(execution.id)).toBe(false)
    expect(await recovered.store.recoverSession(execution.id)).not.toHaveProperty('nativeSessionId')
    await recovered.store.failExecution(execution.id, 'NATIVE_SESSION_START_UNCERTAIN')
    const resolution = (await recovered.store.readResolutions()).get(execution.workflowNodeId)!
    expect(resolution).toMatchObject({ resolution: 'failed', selectedRelationshipIds: [] })
    expect((await db.pool.query('select 1 from execution_native_sessions where execution_id=$1', [execution.id])).rowCount).toBe(0)
    expect((await db.pool.query('select pending from run_cleanup_intents where run_id=$1', [fixture.run.id])).rows[0].pending).toBe(true)
  })

  it('treats an actually committed but lost COMMIT response as uncertain, not retryable dispatch', async () => {
    const fixture = await seedAgent3(db.pool, db.directory)
    const owner = (await RunOwnership.acquire(db.pool, fixture.run.id, () => undefined))!; owners.push(owner)
    const raw = owner.client // capture before the exclusive facade adopts the session
    const store = new OneShotRunRepository(owner)
    const execution = await admit(store, fixture)
    const query = raw.query.bind(raw)
    let lose = true
    vi.spyOn(raw, 'query').mockImplementation(((text: string, values?: unknown[]) => {
      const pending = query(text, values)
      if (text === 'commit' && lose) {
        lose = false
        return pending.then(() => { throw new Error('A3_LOST_COMMIT_RESPONSE') })
      }
      return pending
    }) as typeof raw.query)
    await expect(store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/uncertain` })).rejects.toThrow('A3_LOST_COMMIT_RESPONSE')
    expect(store.consumeLaunchPermit(execution.id)).toBe(false)
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [fixture.run.id])).rowCount).toBe(1)
    await expect(store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/uncertain` })).rejects.toThrow()
    vi.restoreAllMocks(); await owner.release()
    const next = await ownedAgent3(db.pool, fixture); owners.push(next.owner)
    expect(await next.store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/uncertain` })).toBeUndefined()
  })

  it('repairs only the bind-session/execution-row crash gap and keeps exact provider/session identity', async () => {
    const { fixture, store } = await fresh()
    const execution = await admit(store, fixture)
    await store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/same` })
    const reference = { harness: 'codex' as const, providerVersion: 'exact-old-provider', nativeSessionId: 'exact-existing-session' }
    await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(execution.id, reference)
    const repaired = await store.recoverSession(execution.id)
    expect(repaired.nativeSessionId).toBe(reference.nativeSessionId)
    expect(await store.exactSession(execution.id)).toEqual(reference)
    const head = await graphHead(db.pool, fixture.run.id)
    expect(await store.recoverSession(execution.id)).toEqual(repaired)
    expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
    expect(await store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/replacement` })).toBeUndefined()
    await expect(store.updateExecution({ ...repaired, nativeSessionId: 'replacement' })).rejects.toThrow()
  })

  it('Stop wins a blocked launch claim and leaves the queued row resource-free', async () => {
    const { fixture, store, owner } = await fresh()
    const execution = await admit(store, fixture)
    const stop = await stopHoldingLock(fixture)
    const claim = store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/never` })
    const rejected = expect(claim).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    try { await blocked(owner) } finally { stop.release.resolve() }
    await stop.task; await rejected
    const record = HarnessExecutionSchema.parse((await db.pool.query<{ record: unknown }>('select record from harness_executions where id=$1', [execution.id])).rows[0]!.record)
    expect(record.state).toBe('queued'); expect(record.runtimeDirectory).toBeUndefined()
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [fixture.run.id])).rowCount).toBe(0)
  })

  it('Stop after a committed claim invalidates the final native boundary check', async () => {
    const { fixture, store } = await fresh()
    const execution = await admit(store, fixture)
    await store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/never` })
    await changeOneShotLifecycle(db.pool, fixture.run.id, { kind: 'stop' })
    await expect(store.assertNativeBoundary(execution.id)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    await store.settleRun(true)
    const head = await graphHead(db.pool, fixture.run.id)
    await store.settleRun(true)
    expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
  })

  it('Stop wins result acceptance without rewriting already persisted terminal native evidence', async () => {
    const { fixture, store, owner } = await fresh()
    const execution = await admit(store, fixture)
    const terminal = await terminalAgent3(db.pool, store, fixture, execution)
    const stop = await stopHoldingLock(fixture)
    const accept = store.acceptTerminal(execution.id)
    const rejected = expect(accept).rejects.toThrow()
    try { await blocked(owner) } finally { stop.release.resolve() }
    await stop.task; await rejected
    const row = (await db.pool.query<{ record: unknown; accepted: boolean }>('select record,accepted from harness_executions where id=$1', [execution.id])).rows[0]!
    expect(row.record).toEqual(terminal); expect(row.accepted).toBe(false)
    expect((await store.readResolutions()).has(execution.workflowNodeId)).toBe(false)
  })

  it.each(['stop', 'completion'] as const)('%s wins the independent completion/Stop race monotonically', async (winner) => {
    const { fixture, store, owner } = await fresh()
    for (const node of fixture.version.definition.nodes) {
      const execution = await admit(store, fixture, node.id)
      await terminalAgent3(db.pool, store, fixture, execution)
      await store.acceptTerminal(execution.id)
    }
    if (winner === 'stop') {
      const stop = await stopHoldingLock(fixture)
      const completion = store.completeRun()
      const rejected = expect(completion).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
      try { await blocked(owner) } finally { stop.release.resolve() }
      await stop.task; await rejected; await store.settleRun(true)
    } else {
      await store.completeRun()
      await changeOneShotLifecycle(db.pool, fixture.run.id, { kind: 'stop' })
    }
    const before = (await db.pool.query<{ record: { outcome: string } }>('select record from runs where id=$1', [fixture.run.id])).rows[0]!.record
    expect(before.outcome).toBe(winner === 'stop' ? 'canceled' : 'succeeded')
    await changeOneShotLifecycle(db.pool, fixture.run.id, { kind: 'cleanup', pending: false })
    await expect(store.updateRun({ executionState: 'running', outcome: 'pending' })).rejects.toThrow()
    expect((await db.pool.query('select record from runs where id=$1', [fixture.run.id])).rows[0].record).toEqual(before)
  })

  it('a stale owner cannot settle, accept, queue or dispatch after its actual advisory lock is gone', async () => {
    const { fixture, owner, store } = await fresh()
    const execution = await admit(store, fixture)
    const head = await graphHead(db.pool, fixture.run.id)
    await owner.oneShotConnection().query('select pg_advisory_unlock($1,hashtext($2))', [810002, fixture.run.id])
    const replacement = await ownedAgent3(db.pool, fixture); owners.push(replacement.owner)
    await expect(store.failExecution(execution.id, 'STALE_CALLBACK')).rejects.toThrow('no longer owns')
    await expect(store.admit(fixture.identities[1]!.workflowNodeId, () => candidateFor(fixture))).rejects.toThrow()
    await expect(store.claimLaunch(execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/stale` })).rejects.toThrow()
    expect(await graphHead(db.pool, fixture.run.id)).toBe(head)
    expect(await replacement.store.admit(execution.workflowNodeId, () => { throw new Error('No duplicate') })).toMatchObject({ kind: 'admitted', reused: true })
  })

  it('abnormal execution loss resolves its outgoing edges and ends the Run without stranding a dependency', async () => {
    const { fixture, store } = await fresh()
    const execution = await admit(store, fixture)
    await store.failExecution(execution.id, 'NATIVE_CHILD_LOST')
    const first = (await store.readResolutions()).get(execution.workflowNodeId)!
    expect(NodeResolutionSchema.parse(first)).toMatchObject({ resolution: 'failed', selectedRelationshipIds: [], unselectedRelationshipIds: [fixture.version.definition.edges[0]!.id] })
    const skipped = await store.admit(fixture.identities[1]!.workflowNodeId, () => { throw new Error('Skipped dependent has no native resources') })
    expect(skipped).toMatchObject({ kind: 'resolved', resolution: { resolution: 'skipped' } })
    await store.settleRun(false)
    expect((await db.pool.query('select execution_state,record from runs where id=$1', [fixture.run.id])).rows[0]).toMatchObject({ execution_state: 'completed', record: { outcome: 'failed' } })
  })
})
