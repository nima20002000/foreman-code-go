import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  makeWave25Fixture, applyRunGraphPageFixture, type GraphFact,
  type InputBinding, type RunGraphCurrentState, type GraphEffectIdentity, type GraphEffectAuthority, type GraphEffectFence,
} from '@graphql/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { wave25ReliabilityMigration } from '../src/infrastructure/wave25ReliabilityMigration.js'
import { wave25RunGraphMigration } from '../src/infrastructure/wave25RunGraphMigration.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { withExclusiveGraphConnection, beforeGraphCommit, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { graphSourceDigest, openRunGraphPublication, withRunGraphPublication, type GraphEffectChange, type GraphEffectGuard } from '../src/modules/run-graph/publication.js'
import { readRunGraphPage, readRunGraphSnapshot, type AuthorizeRunGraphRead } from '../src/modules/run-graph/reader.js'
import { putNodeResolution, readInputBindings, readNodeResolutions } from '../src/modules/run-graph/records.js'
import { exampleAcceptResult, exampleBindInput } from './helpers/runGraphProducers.js'

type Fixture = ReturnType<typeof makeWave25Fixture>
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
// Explicit opt-in: these are REAL PostgreSQL tests, never backed by a mock DB.
// The random schema is the only object dropped. No native harness is invoked.
describe.skipIf(process.env.RUN_WAVE25_POSTGRES_TESTS !== '1')('run graph PostgreSQL publication (independent connections)', () => {
  let admin: pg.Pool, pool: pg.Pool
  const schema = `wave25_test_${randomUUID().replaceAll('-', '')}`
  let legacyBefore: unknown, legacyRunId: string
  const principal: ManagementPrincipal = {
    id: 'wave25-test-operator', name: 'Synthetic test Operator', audience: 'operator',
    grants: [{ actions: ['runs:read'], scope: {} }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  const authorize: AuthorizeRunGraphRead = async (_sql, scope) => {
    requireAuthorization(principal, 'runs:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId })
  }
  beforeAll(async () => {
    const url = process.env.WAVE25_TEST_DATABASE_URL
    if (!url) throw new Error('WAVE25_TEST_DATABASE_URL is required when explicitly enabled')
    const parsed = new URL(url)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
      throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    }
    admin = new pg.Pool({ connectionString: url, max: 1 })
    await admin.query(`create schema ${schema}`)
    pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000` })
    await applyApplicationMigrations(pool)
    const registered = await pool.query('select 1 from application_migrations where version=$1', [wave25RunGraphMigration.version])
    // For S0 plus the owned patch, registration is intentionally terminal-owned.
    // Seed populated legacy records BEFORE the additive migration when unregistered.
    if (!registered.rowCount) {
      const legacy = makeWave25Fixture(`legacy-${randomUUID()}`)
      const version = structuredClone(legacy.version) as unknown as Record<string, unknown>
      delete version.executionSemanticsVersion
      const definition = version.definition as Record<string, unknown>
      delete definition.executionSemanticsVersion; delete definition.entryNodeId
      definition.edges = legacy.version.definition.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, route: { outcomes: ['succeeded'] } }))
      const run = structuredClone(legacy.run) as unknown as Record<string, unknown>
      delete run.executionSemanticsVersion
      await insertParents(legacy, version, run, false)
      legacyRunId = legacy.run.id
      legacyBefore = (await pool.query('select r.record as run,v.record as version from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1', [legacyRunId])).rows[0]
      const migration = await pool.connect()
      try {
        await migration.query('begin')
        await migration.query(wave25RunGraphMigration.sql)
        await migration.query('insert into application_migrations(version) values($1)', [wave25RunGraphMigration.version])
        await migration.query('commit')
      } catch (error) { await migration.query('rollback'); throw error } finally { migration.release() }
    }
    const reliabilityRegistered = await pool.query('select 1 from application_migrations where version=$1', [wave25ReliabilityMigration.version])
    if (!reliabilityRegistered.rowCount) {
      const migration = await pool.connect()
      try {
        await migration.query('begin')
        await migration.query(wave25ReliabilityMigration.sql)
        await migration.query('insert into application_migrations(version) values($1)', [wave25ReliabilityMigration.version])
        await migration.query('commit')
      } catch (error) { await migration.query('rollback'); throw error } finally { migration.release() }
    }
    await pool.query('create table wave25_test_facts(run_id text primary key references runs(id),value integer not null default 0,private_body text)')
    // Test-only stand-in for an EXISTING authority's locked rows, not production runtime ownership.
    await pool.query(`create table wave25_test_authority(run_id text references runs(id),effect_kind text,entity_id text,
      record jsonb not null,primary key(run_id,effect_kind,entity_id))`)

  }, 60000)
  afterAll(async () => {
    await pool?.end()
    if (admin) { await admin.query(`drop schema if exists ${schema} cascade`); await admin.end() }
  })

  async function insertParents(fixture: Fixture, version: unknown = fixture.version, run: unknown = fixture.run, v2 = true) {
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [fixture.scope.workspaceId, JSON.stringify({ id: fixture.scope.workspaceId, name: 'Synthetic' })])
    for (const configuration of fixture.configurations) {
      await pool.query('insert into agents(id,workspace_id,current_configuration_version_id,record) values($1,$2,null,$3::jsonb)', [configuration.agentId, fixture.scope.workspaceId, JSON.stringify({ id: configuration.agentId, name: 'Synthetic Worker', productRole: configuration.productRole })])
      await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)', [configuration.id, fixture.scope.workspaceId, configuration.agentId, JSON.stringify(configuration)])
      await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [configuration.agentId, configuration.id])
    }
    await pool.query('insert into workflows(id,workspace_id,current_version_id,record) values($1,$2,null,$3::jsonb)', [fixture.scope.workflowId, fixture.scope.workspaceId, JSON.stringify((version as Fixture['version']).definition)])
    await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record${v2 ? ',execution_semantics_version' : ''}) values($1,$2,$3,1,$4,$5::jsonb${v2 ? ',2' : ''})`, [fixture.version.id, fixture.scope.workspaceId, fixture.scope.workflowId, fixture.version.entryNodeId, JSON.stringify(version)])
    await pool.query('update workflows set current_version_id=$2 where id=$1', [fixture.scope.workflowId, fixture.version.id])
    await pool.query('insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,$5,$6::jsonb)', [fixture.run.id, fixture.scope.workspaceId, fixture.scope.workflowId, fixture.version.id, 'queued', JSON.stringify(run)])
  }
  async function fresh(): Promise<Fixture> {
    const fixture = makeWave25Fixture(randomUUID())
    await insertParents(fixture)
    await pool.query('insert into wave25_test_facts(run_id,value) values($1,0)', [fixture.scope.runId])
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async () => undefined, { historyCoverage: 'from_admission' }))
    return fixture
  }
  const fact = (fixture: Fixture, value: number): GraphFact => ({ type: 'run.state', state: { ...fixture.snapshot.state.run, pendingInteractionCount: value } })
  const source = (fixture: Fixture, id: string, value: number) => ({
    evidence: { sourceKind: 'run' as const, sourceId: id, sourceRevision: '0' },
    sourceDigest: graphSourceDigest({ value, privateBody: 'do-not-publish-credentials-or-paths' }), facts: [fact(fixture, value)],
  })
  const mutate = (fixture: Fixture, value: number) => (sql: GraphTransactionSql) => sql.query('update wave25_test_facts set value=$2,private_body=$3 where run_id=$1', [fixture.scope.runId, value, 'do-not-publish-credentials-or-paths'])
  const publish = (fixture: Fixture, id: string, value: number) => withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => publication.source(source(fixture, id, value), mutate(fixture, value))))
  const page = (fixture: Fixture, afterSequence = '0') => readRunGraphPage(pool, { scope: fixture.scope, protocolVersion: 1, afterSequence }, authorize)
  const snapshot = (fixture: Fixture, pause?: () => Promise<void>) => readRunGraphSnapshot(pool, { scope: fixture.scope, protocolVersion: 1 }, authorize, async (sql) => {
    await pause?.()
    const row = (await sql.query<{ value: number }>('select value from wave25_test_facts where run_id=$1', [fixture.scope.runId])).rows[0]!
    return { topology: fixture.snapshot.topology, state: { ...fixture.snapshot.state, run: { ...fixture.snapshot.state.run, pendingInteractionCount: row.value } } }
  })
  async function blocked(pid: number) {
    for (let i = 0; i < 100; i++) {
      const row = (await pool.query<{ blockers: number[] }>('select pg_blocking_pids($1) as blockers', [pid])).rows[0]!
      if (row.blockers.length) return row.blockers
      await delay(10)
    }
    throw new Error('Expected independent PostgreSQL writer to block on the held Run lock')
  }

  it('preserves populated legacy JSON and initializes no legacy graph head', async () => {
    if (!legacyRunId) {
      // If the terminal registered the migration, its fresh-DB application was exercised above.
      expect((await pool.query('select 1 from application_migrations where version=250001')).rowCount).toBe(1)
      return
    }
    expect((await pool.query('select r.record as run,v.record as version from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1', [legacyRunId])).rows[0]).toEqual(legacyBefore)
    expect((await pool.query('select * from run_graph_heads where run_id=$1', [legacyRunId])).rowCount).toBe(0)
    expect((await pool.query('select v.execution_semantics_version from workflow_versions v join runs r on r.workflow_version_id=v.id where r.id=$1', [legacyRunId])).rows[0].execution_semantics_version).toBe(1)
  })
  it('serializes independent writers through commit; no uncommitted publication escapes', async () => {
    const fixture = await fresh(), entered = deferred(), release = deferred(), bStarted = deferred()
    let aPid = 0, bPid = 0
    const a = withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      aPid = (await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const publication = await openRunGraphPublication(sql, fixture.scope)
      await publication.source(source(fixture, 'source-a', 1), mutate(fixture, 1))
      entered.resolve()
      // Test-only latch deliberately forces an overlap. Production transactions must not wait on external work.
      await release.promise
    }))
    await entered.promise
    const b = withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      bPid = (await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      bStarted.resolve()
      const publication = await openRunGraphPublication(sql, fixture.scope)
      await publication.source(source(fixture, 'source-b', 2), mutate(fixture, 2))
    }))
    void b.catch(() => undefined)
    try {
      await bStarted.promise
      expect(bPid).not.toBe(aPid)
      expect(await blocked(bPid)).toContain(aPid)
      expect((await page(fixture)).headSequence).toBe('0')
    } finally { release.resolve(); await Promise.all([a, b]) }
    const result = await page(fixture)
    expect(result.kind).toBe('page')
    if (result.kind === 'page') expect(result.batches.map((batch) => batch.sequence)).toEqual(['1', '2'])
  })
  it('does not use allocation-ordered Activity identity as the committed cursor', async () => {
    const fixture = await fresh()
    const first = await pool.connect(), second = await pool.connect()
    try {
      const allocatedA = (await first.query<{ n: string }>("select nextval(pg_get_serial_sequence('run_activity','sequence'))::text as n")).rows[0]!.n
      const allocatedB = (await second.query<{ n: string }>("select nextval(pg_get_serial_sequence('run_activity','sequence'))::text as n")).rows[0]!.n
      expect(BigInt(allocatedA) < BigInt(allocatedB)).toBe(true)
      // B commits first despite having the later preallocated legacy identity.
      const b = await publish(fixture, `activity-${allocatedB}`, 2)
      const a = await publish(fixture, `activity-${allocatedA}`, 1)
      expect([b.publication.sequence, a.publication.sequence]).toEqual(['1', '2'])
      const result = await page(fixture)
      if (result.kind !== 'page') throw new Error('Unexpected reset')
      expect(result.batches.map((batch) => batch.events[0]!.evidence.sourceId)).toEqual([`activity-${allocatedB}`, `activity-${allocatedA}`])
    } finally { first.release(); second.release() }
  })
  it('rolls back state, source receipts and counter without leaving a cursor hole', async () => {
    const fixture = await fresh()
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async (publication) => {
      await publication.source(source(fixture, 'rollback', 9), mutate(fixture, 9))
      throw new Error('test rollback')
    }))).rejects.toThrow('test rollback')
    expect((await snapshot(fixture)).asOfSequence).toBe('0')
    expect((await snapshot(fixture)).state.run.pendingInteractionCount).toBe(0)
    expect((await pool.query('select 1 from run_graph_sources where run_id=$1', [fixture.scope.runId])).rowCount).toBe(0)
    expect((await publish(fixture, 'after-rollback', 1)).publication.sequence).toBe('1')
  })
  it('deduplicates exact replay before mutation, and poisons conflicts even when caught', async () => {
    const fixture = await fresh()
    await publish(fixture, 'same-source', 1)
    const mutation = vi.fn(mutate(fixture, 99))
    const duplicate = await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => publication.source(source(fixture, 'same-source', 1), mutation)))
    expect(duplicate.value.replayed).toBe(true)
    expect(duplicate.publication.kind).toBe('none')
    expect(mutation).not.toHaveBeenCalled()
    for (const conflict of [source(fixture, 'same-source', 2), { ...source(fixture, 'same-source', 1), facts: [fact(fixture, 2)] }]) {
      await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async (publication) => {
        await publication.source(source(fixture, 'would-roll-back', 3), mutate(fixture, 3))
        await publication.source(conflict, mutate(fixture, 2)).catch(() => undefined)
      }))).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
    }
    expect((await snapshot(fixture)).state.run.pendingInteractionCount).toBe(1)
    expect((await page(fixture)).headSequence).toBe('1')
  })
  it('orders concurrent appends numerically beyond nine and returns complete paginated batches', async () => {
    const fixture = await fresh()
    await Promise.all(Array.from({ length: 20 }, (_, index) => publish(fixture, `append-${index}`, index)))
    const first = await page(fixture)
    if (first.kind !== 'page') throw new Error('Unexpected reset')
    expect(first.batches).toHaveLength(16)
    expect(first.batches.map((batch) => batch.sequence)).toEqual(Array.from({ length: 16 }, (_, index) => String(index + 1)))
    expect(first.throughSequence).toBe('16'); expect(first.headSequence).toBe('20'); expect(first.hasMore).toBe(true)
    const second = await page(fixture, first.throughSequence)
    if (second.kind !== 'page') throw new Error('Unexpected reset')
    expect(second.batches.map((batch) => batch.sequence)).toEqual(['17', '18', '19', '20'])
    expect(second.hasMore).toBe(false)
  })
  it('publishes several domain changes as ONE complete batch', async () => {
    const fixture = await fresh()
    const result = await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async (publication) => {
      await publication.source(source(fixture, 'atomic-a', 1), mutate(fixture, 1))
      await publication.source(source(fixture, 'atomic-b', 2), mutate(fixture, 2))
    }))
    expect(result.publication.sequence).toBe('1')
    const delivered = await page(fixture)
    if (delivered.kind !== 'page') throw new Error('Unexpected reset')
    expect(delivered.batches).toHaveLength(1); expect(delivered.batches[0]!.events).toHaveLength(2)
    expect((await snapshot(fixture)).state.run.pendingInteractionCount).toBe(2)
  })
  it('makes oversized atomic changes explicit reset barriers without dropping domain facts or dedup receipts', async () => {
    const fixture = await fresh()
    const result = await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async (publication) => {
      for (let value = 1; value <= 65; value++) await publication.source(source(fixture, `oversized-${value}`, value), mutate(fixture, value))
    }))
    expect(result.publication.kind).toBe('reset')
    expect(await page(fixture)).toMatchObject({ kind: 'reset', reason: 'atomic_change_too_large', headSequence: '1' })
    expect((await pool.query('select 1 from run_graph_sources where run_id=$1', [fixture.scope.runId])).rowCount).toBe(65)
    const current = await snapshot(fixture)
    expect(current.asOfSequence).toBe('1'); expect(current.state.run.pendingInteractionCount).toBe(65)
    expect(await page(fixture, current.asOfSequence)).toMatchObject({ kind: 'page', throughSequence: '1', batches: [] })
  })
  it('preserves cursors above Number.MAX_SAFE_INTEGER exactly', async () => {
    const fixture = await fresh()
    await pool.query('update run_graph_heads set head_sequence=$2::bigint,retention_floor=$2::bigint where run_id=$1', [fixture.scope.runId, '9007199254740993'])
    expect((await publish(fixture, 'large-cursor', 1)).publication.sequence).toBe('9007199254740994')
    expect(await page(fixture, '9007199254740993')).toMatchObject({ kind: 'page', throughSequence: '9007199254740994' })
  })
  it('reports expired, ahead, gapped, excessive catch-up and incompatible journal bodies explicitly', async () => {
    const fixture = await fresh()
    await publish(fixture, 'one', 1); await publish(fixture, 'two', 2)
    expect(await page(fixture, '3')).toMatchObject({ kind: 'reset', reason: 'cursor_ahead' })
    await pool.query('delete from run_graph_batches where run_id=$1 and sequence=1', [fixture.scope.runId])
    expect(await page(fixture)).toMatchObject({ kind: 'reset', reason: 'gap' })
    await pool.query('update run_graph_heads set retention_floor=1 where run_id=$1', [fixture.scope.runId])
    expect(await page(fixture)).toMatchObject({ kind: 'reset', reason: 'history_expired' })
    expect((await publish(fixture, 'one', 1)).publication.kind).toBe('none') // Sources survive retention.
    await pool.query('update run_graph_batches set payload=$2 where run_id=$1 and sequence=2', [fixture.scope.runId, '{"protocolVersion":99}'])
    expect(await page(fixture, '1')).toMatchObject({ kind: 'reset', reason: 'schema_changed' })
    await pool.query('update run_graph_heads set head_sequence=3000 where run_id=$1', [fixture.scope.runId])
    expect(await page(fixture, '1')).toMatchObject({ kind: 'reset', reason: 'catchup_limit' })
  })
  it('takes snapshot and cursor from one database cut and snapshot + deltas matches the later snapshot', async () => {
    const fixture = await fresh(), cut = deferred(), release = deferred()
    const reading = snapshot(fixture, async () => { cut.resolve(); await release.promise })
    await cut.promise
    try { await publish(fixture, 'after-cut', 1) } finally { release.resolve() }
    const before = await reading
    expect(before.asOfSequence).toBe('0'); expect(before.state.run.pendingInteractionCount).toBe(0)
    const after = await snapshot(fixture)
    const applied = applyRunGraphPageFixture(before, await page(fixture, before.asOfSequence), 1, 1)
    expect(applied.kind).toBe('applied'); expect(applied.snapshot).toEqual(after)
  })
  it('requires authorization, denies scoped outsiders, and validates the durable tuple', async () => {
    const fixture = await fresh(), assemble = vi.fn(async () => ({ topology: fixture.snapshot.topology, state: fixture.snapshot.state }))
    const deny: AuthorizeRunGraphRead = async (_sql, scope) => requireAuthorization({ ...principal, grants: [] }, 'runs:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId })
    await expect(readRunGraphSnapshot(pool, { scope: fixture.scope, protocolVersion: 1 }, deny, assemble)).rejects.toThrow('GRAPH_READ_ACCESS_DENIED')
    expect(assemble).not.toHaveBeenCalled()
    const appCaller: AuthorizeRunGraphRead = async (_sql, scope) => requireAuthorization({ ...principal, audience: 'worker', agentId: fixture.configurations[0]!.agentId }, 'runs:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId })
    await expect(readRunGraphSnapshot(pool, { scope: fixture.scope, protocolVersion: 1 }, appCaller, assemble)).rejects.toThrow('GRAPH_READ_ACCESS_DENIED')
    await expect(readRunGraphPage(pool, { scope: { ...fixture.scope, workflowId: 'other-workflow' }, protocolVersion: 1, afterSequence: '0' }, authorize)).rejects.toThrow('GRAPH_SCOPE_MISMATCH')
    await expect(readRunGraphPage(pool, { scope: fixture.scope, protocolVersion: 1, afterSequence: 1 }, authorize)).rejects.toThrow('GRAPH_INVALID_CURSOR')
    await expect(readRunGraphPage(pool, { scope: fixture.scope, protocolVersion: 99, afterSequence: '0' }, authorize)).rejects.toThrow('GRAPH_UNSUPPORTED_PROTOCOL')
    expect((await snapshot(fixture)).scope).toEqual(fixture.scope)
  })
  it('does not expose private domain payloads in the journal', async () => {
    const fixture = await fresh()
    await publish(fixture, 'redaction', 1)
    const delivered = JSON.stringify(await page(fixture))
    expect(delivered).not.toContain('do-not-publish-credentials-or-paths')
    expect((await pool.query('select private_body from wave25_test_facts where run_id=$1', [fixture.scope.runId])).rows[0].private_body).toContain('do-not-publish')
  })
  it('allows cleanup publication after terminal business outcome without resurrecting native work', async () => {
    const fixture = await fresh()
    const state: RunGraphCurrentState['run'] = { executionState: 'completed', outcome: 'succeeded', stopRequested: false, cleanupPending: true, unsettledReviewCount: 1, pendingInteractionCount: 0 }
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => publication.source({ ...source(fixture, 'terminal-cleanup', 1), facts: [{ type: 'run.state', state }] }, async (sql) => {
      await sql.query("update runs set execution_state='completed',record=record||$2::jsonb where id=$1", [fixture.scope.runId, JSON.stringify({ executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: null }, finishedAt: fixture.createdAt })])
    })))
    const settled = { ...state, cleanupPending: false, unsettledReviewCount: 0 }
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => publication.source({ ...source(fixture, 'cleanup-settled', 2), facts: [{ type: 'run.state', state: settled }] }, mutate(fixture, 2))))
    expect((await page(fixture)).headSequence).toBe('2')
  })
  it('persists actual accepted-result and exact recipient-input receipts through the real primitive', async () => {
    const fixture = await fresh()
    for (const execution of fixture.executions) await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)', [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
    const result = { outcome: 'succeeded' as const, output: { accepted: 'private result, not a graph payload' } }
    const edgeId = fixture.version.definition.edges[0]!.id
    const resultAuthority = await effectContext(fixture, 'result.accept', fixture.identities[0]!.executionId, graphSourceDigest({ identity: fixture.identities[0], result, resolvedAt: fixture.createdAt, selectedRelationshipIds: [edgeId], unselectedRelationshipIds: [] }))
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => exampleAcceptResult(publication, fixture.identities[0]!, resultAuthority.guard, result, fixture.createdAt, [edgeId])))
    const input = { executionSemanticsVersion: 2, runInput: {}, predecessors: [{ relationshipId: edgeId, senderNodeId: fixture.identities[0]!.workflowNodeId, senderExecutionId: fixture.identities[0]!.executionId, acceptedResult: result }] }
    const binding: InputBinding = { bindingId: 'binding-1', relationshipId: edgeId, sender: fixture.identities[0]!, recipient: fixture.identities[1]!, acceptedResultDigest: graphSourceDigest(result), recipientInputDigest: graphSourceDigest(input), inputOrdinal: 0, boundAt: fixture.createdAt }
    const bindingAuthority = await effectContext(fixture, 'input.bind', binding.bindingId, graphSourceDigest({ binding, input }))
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => exampleBindInput(publication, binding, input, bindingAuthority.guard)))
    const saved = await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => ({ resolutions: await readNodeResolutions(sql, fixture.scope), bindings: await readInputBindings(sql, fixture.scope) }), true))
    expect(saved.resolutions[0]!.acceptedResultDigest).toBe(binding.acceptedResultDigest)
    expect(saved.bindings).toEqual([binding])
    const serialized = JSON.stringify(await page(fixture))
    expect(serialized).not.toContain('private result')
    const wrongResult = { ...binding, bindingId: 'wrong-result', acceptedResultDigest: 'sha256:' + 'f'.repeat(64) }
    const wrongAuthority = await effectContext(fixture, 'input.bind', wrongResult.bindingId, graphSourceDigest({ binding: wrongResult, input }))
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => exampleBindInput(publication, wrongResult, input, wrongAuthority.guard)))).rejects.toThrow('GRAPH_INVARIANT_VIOLATION')
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) => putNodeResolution(publication.sql, fixture.scope, { workflowNodeId: fixture.identities[1]!.workflowNodeId, resolution: 'skipped', branchEnded: false, selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: fixture.createdAt })))).rejects.toThrow('GRAPH_INVARIANT_VIOLATION')
    // A matching receipt/execution pair cannot substitute another immutable configuration pin.
    const wrongPin = { ...binding.recipient, agentConfigurationVersionId: fixture.configurations[0]!.id }
    await pool.query("update harness_executions set record=jsonb_set(record,'{agentConfigurationVersionId}',to_jsonb($2::text)) where id=$1", [wrongPin.executionId, wrongPin.agentConfigurationVersionId])
    const wrongPinBinding = { ...binding, bindingId: 'wrong-pin', recipient: wrongPin }
    const wrongPinAuthority = await effectContext(fixture, 'input.bind', wrongPinBinding.bindingId, graphSourceDigest({ binding: wrongPinBinding, input }))
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => exampleBindInput(publication, wrongPinBinding, input, wrongPinAuthority.guard)))).rejects.toThrow('GRAPH_INVARIANT_VIOLATION')
    expect((await page(fixture)).headSequence).toBe('2')
  })
  it('avoids a Run-FK deadlock when legacy append already owns an execution row', async () => {
    const fixture = await fresh(), execution = fixture.executions[0]!
    await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)', [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
    const legacy = await pool.connect(), ownsHead = deferred()
    let graphPid = 0
    await legacy.query('begin')
    await legacy.query('select id from harness_executions where id=$1 for update', [execution.id])
    const writing = withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      graphPid = (await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const publication = await openRunGraphPublication(sql, fixture.scope)
      ownsHead.resolve()
      await sql.query('select id from harness_executions where id=$1 for update', [execution.id])
      await publication.source(source(fixture, 'after-native-append', 1), mutate(fixture, 1))
    }))
    void writing.catch(() => undefined)
    try {
      await ownsHead.promise
      expect((await blocked(graphPid)).length).toBeGreaterThan(0)
      // This existing execution-first function inserts an Activity row with a Run FK.
      await legacy.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({ executionId: execution.id, sequence: 0, occurredAt: fixture.createdAt, type: 'synthetic.no_native_work', payload: {} })])
      await legacy.query('commit')
      await writing
    } finally { await legacy.query('rollback'); legacy.release(); await writing.catch(() => undefined) }
    expect((await page(fixture)).headSequence).toBe('1')
  })

  async function effectContext(fixture: Fixture, kind: GraphEffectIdentity['kind'] = 'execution.launch', entityId = fixture.identities[0]!.executionId, acceptedEffectDigest?: string) {
    const effect = { identity: { kind, entityId }, digest: acceptedEffectDigest ?? graphSourceDigest({ kind, entityId, acceptedNativeSession: 'synthetic-exact-session' }) }
    const expected: GraphEffectFence = { scope: fixture.scope, effect: effect.identity, effectDigest: effect.digest,
      ownerId: 'existing-owner', fence: '9007199254740993', connectionGeneration: '4' }
    const current: GraphEffectAuthority = { ...expected, ownership: 'held', access: 'effect', security: 'valid', effectClosed: false, submission: 'not_submitted' }
    await pool.query(`insert into wave25_test_authority(run_id,effect_kind,entity_id,record) values($1,$2,$3,$4::jsonb)`,
      [fixture.scope.runId, kind, entityId, JSON.stringify(current)])
    const guard: GraphEffectGuard = { expected, readCurrentLocked: async (sql, scope, identity) => {
      const row = (await sql.query<{ record: GraphEffectAuthority }>(
        `select record from wave25_test_authority where run_id=$1 and effect_kind=$2 and entity_id=$3 for update`,
        [scope.runId, identity.kind, identity.entityId])).rows[0]
      if (!row) throw new Error('GRAPH_AUTHORITY_INVALID')
      return row.record
    } }
    const change = (sourceId: string): GraphEffectChange => ({ ...source(fixture, sourceId, 1), effect })
    const perform = (sourceId: string) => withExclusiveGraphConnection(pool, (connection) =>
      withRunGraphPublication(connection, fixture.scope, (publication) => publication.effect(change(sourceId), guard, mutate(fixture, 1))))
    return { expected, current, guard, change, perform }
  }
  async function reliabilityCounts(fixture: Fixture) {
    return (await pool.query<{ head: string; sources: number; effects: number; value: number }>(
      `select h.head_sequence::text as head,(select count(*)::int from run_graph_sources s where s.run_id=h.run_id) as sources,
        (select count(*)::int from run_graph_effects e where e.run_id=h.run_id) as effects,f.value
       from run_graph_heads h join wave25_test_facts f on f.run_id=h.run_id where h.run_id=$1`, [fixture.scope.runId])).rows[0]!
  }
  async function changeAuthority(fixture: Fixture, current: GraphEffectAuthority, patch: Partial<GraphEffectAuthority>) {
    // A separate actual pool connection supplies the current stored authority read by the guard.
    await pool.query('update wave25_test_authority set record=$4::jsonb where run_id=$1 and effect_kind=$2 and entity_id=$3',
      [fixture.scope.runId, current.effect.kind, current.effect.entityId, JSON.stringify({ ...current, ...patch })])
  }
  it('deduplicates differently identified observations of one effect before any second mutation or cursor', async () => {
    const fixture = await fresh(), context = await effectContext(fixture)
    expect((await context.perform('observation-a')).publication.sequence).toBe('1')
    const duplicate = await context.perform('observation-a')
    expect(duplicate.value.replayed).toBe(true); expect(duplicate.publication.sequence).toBeNull()
    const alias = await context.perform('observation-b')
    expect(alias.value.replayed).toBe(true); expect(alias.publication.kind).toBe('none')
    expect(await reliabilityCounts(fixture)).toEqual({ head: '1', sources: 2, effects: 1, value: 1 })
    // Even after ownership loss an exact persisted receipt is readback, not permission to mutate.
    await changeAuthority(fixture, context.current, { ownership: 'lost', security: 'unknown' })
    expect((await context.perform('observation-c')).publication.sequence).toBeNull()
    const changed = context.change('observation-d')
    changed.effect = { ...changed.effect, digest: graphSourceDigest('different-command') }
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(changed, context.guard, mutate(fixture, 99))))).rejects.toThrow('GRAPH_EFFECT_CONFLICT')
    expect(await reliabilityCounts(fixture)).toEqual({ head: '1', sources: 3, effects: 1, value: 1 })
  })
  it('stages aliases in one batch and keeps effect deduplication across journal retention', async () => {
    const fixture = await fresh(), context = await effectContext(fixture), called = vi.fn(mutate(fixture, 1))
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, async (publication) => {
      await publication.effect(context.change('source-a'), context.guard, called)
      await publication.effect(context.change('source-b'), context.guard, called)
    }))
    expect(called).toHaveBeenCalledTimes(1)
    const before = await page(fixture)
    expect(before.kind).toBe('page')
    if (before.kind === 'page') expect(before.batches[0]!.events).toHaveLength(1)
    // Test-only simulated retention; no production destructive retention is added.
    await pool.query('delete from run_graph_batches where run_id=$1', [fixture.scope.runId])
    await pool.query('update run_graph_heads set retention_floor=1 where run_id=$1', [fixture.scope.runId])
    expect((await context.perform('source-c')).publication.sequence).toBeNull()
    expect(await reliabilityCounts(fixture)).toEqual({ head: '1', sources: 3, effects: 1, value: 1 })
    expect((await page(fixture)).kind).toBe('reset')
  })
  it('rolls back even a late post-publication failure without consuming an effect or public cursor', async () => {
    const fixture = await fresh(), context = await effectContext(fixture)
    await expect(withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, fixture.scope)
      await publication.effect(context.change('late-rollback'), context.guard, mutate(fixture, 1))
      // Registered AFTER publication's finalizer, so this fails after counter/journal/receipt inserts.
      beforeGraphCommit(sql, async () => {
        const row = (await sql.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [fixture.scope.runId])).rows[0]!
        expect(row.head).toBe('1')
        throw new Error('forced-after-publication')
      })
    }))).rejects.toThrow('forced-after-publication')
    expect(await reliabilityCounts(fixture)).toEqual({ head: '0', sources: 0, effects: 0, value: 0 })
    expect((await context.perform('late-rollback')).publication.sequence).toBe('1')
  })
  it.each([
    [{ ownerId: 'successor-owner' }, 'GRAPH_OWNER_LOST'],
    [{ ownership: 'lost' }, 'GRAPH_OWNER_LOST'],
    [{ fence: '9007199254740994' }, 'GRAPH_STALE_FENCE'],
    [{ connectionGeneration: '5' }, 'GRAPH_STALE_GENERATION'],
    [{ access: 'observe' }, 'GRAPH_EFFECT_ACCESS_DENIED'],
    [{ security: 'unknown' }, 'GRAPH_SECURITY_UNQUALIFIED'],
    [{ security: 'invalid' }, 'GRAPH_SECURITY_UNQUALIFIED'],
    [{ submission: 'uncertain' }, 'GRAPH_SUBMISSION_NOT_REPLAYABLE'],
    [{ submission: 'acknowledged' }, 'GRAPH_SUBMISSION_NOT_REPLAYABLE'],
    [{ effectClosed: true }, 'GRAPH_TERMINAL_CONFLICT'],
  ] as Array<[Partial<GraphEffectAuthority>, string]>)('rejects stale/unqualified authority %j before mutation', async (patch, code) => {
    const fixture = await fresh(), context = await effectContext(fixture)
    await changeAuthority(fixture, context.current, patch)
    await expect(context.perform('stale-attempt')).rejects.toThrow(code)
    expect(await reliabilityCounts(fixture)).toEqual({ head: '0', sources: 0, effects: 0, value: 0 })
  })
  it('locks existing authority through the local effect commit; a later owner cannot interleave its fence', async () => {
    const fixture = await fresh(), context = await effectContext(fixture), entered = deferred(), release = deferred()
    const writer = await pool.connect()
    let update: Promise<pg.QueryResult> | undefined
    const first = withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope, (publication) =>
      publication.effect(context.change('current-owner'), context.guard, async (sql) => {
        entered.resolve(); await release.promise // test-only deterministic overlap
        await mutate(fixture, 1)(sql)
      })))
    try {
      await entered.promise
      const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      update = writer.query(`update wave25_test_authority set record=jsonb_set(record,'{fence}','"9007199254740994"'::jsonb) where run_id=$1`, [fixture.scope.runId])
      void update.catch(() => undefined)
      expect((await blocked(pid)).length).toBeGreaterThan(0)
      expect((await page(fixture)).headSequence).toBe('0')
    } finally { release.resolve(); await first; await update; writer.release() }
    expect(await reliabilityCounts(fixture)).toEqual({ head: '1', sources: 1, effects: 1, value: 1 })
  })
  async function stopFixture(fixture: Fixture) {
    const context = await effectContext(fixture, 'run.stop', fixture.scope.runId)
    const run = (await pool.query<{ record: Fixture['run'] }>('select record from runs where id=$1', [fixture.scope.runId])).rows[0]!.record
    const stopped = { ...context.change('stop-source'), facts: [{ type: 'run.state' as const, state: { ...fixture.snapshot.state.run, executionState: run.executionState, outcome: run.outcome, stopRequested: true, cleanupPending: true } }] }
    await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(stopped, context.guard, async () => undefined)))
  }
  async function completeFixture(fixture: Fixture, outcome: 'succeeded' | 'canceled') {
    const record = { ...fixture.run, executionState: 'completed', outcome, result: { outcome }, finishedAt: fixture.createdAt }
    await pool.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [fixture.scope.runId, JSON.stringify(record)])
  }
  it('makes Stop-first reject late success and launch; completion-first keeps its original outcome', async () => {
    const stopped = await fresh(), launch = await effectContext(stopped)
    await stopFixture(stopped)
    await expect(launch.perform('late-launch')).rejects.toThrow('GRAPH_STOP_CONFLICT')
    await expect(completeFixture(stopped, 'succeeded')).rejects.toMatchObject({ code: 'PGR01' })
    await completeFixture(stopped, 'canceled')
    await expect(pool.query('update runs set stop_requested_at=null where id=$1', [stopped.scope.runId])).rejects.toMatchObject({ code: 'PGR01' })
    await expect(pool.query("update runs set execution_state='queued',record=$2::jsonb where id=$1", [stopped.scope.runId, JSON.stringify(stopped.run)])).rejects.toMatchObject({ code: 'PGR02' })
    const completed = await fresh()
    await completeFixture(completed, 'succeeded')
    await stopFixture(completed)
    expect((await pool.query("select record->>'outcome' as outcome,stop_requested_at is not null as stopped from runs where id=$1", [completed.scope.runId])).rows[0]).toEqual({ outcome: 'succeeded', stopped: true })
    await expect(completeFixture(completed, 'canceled')).rejects.toMatchObject({ code: 'PGR02' })
  })
  it('represents oversized atomic effects as a complete reset barrier and keeps every source/effect receipt', async () => {
    const fixture = await fresh(), context = await effectContext(fixture)
    const change = { ...context.change('oversized-effect'), facts: Array.from({ length: 65 }, () => fact(fixture, 1)) }
    const result = await withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(change, context.guard, mutate(fixture, 1))))
    expect(result.publication.kind).toBe('reset')
    expect(await reliabilityCounts(fixture)).toEqual({ head: '1', sources: 1, effects: 1, value: 1 })
    const raw = (await pool.query('select kind,payload,reset_reason from run_graph_batches where run_id=$1', [fixture.scope.runId])).rows[0]
    expect(raw).toEqual({ kind: 'reset', payload: null, reset_reason: 'atomic_change_too_large' })
    expect((await page(fixture)).kind).toBe('reset')
  })

  it('rolls back Stop intent, source/effect receipts and cursor together', async () => {
    const fixture = await fresh(), context = await effectContext(fixture, 'run.stop', fixture.scope.runId)
    const change = { ...context.change('rolled-back-stop'), facts: [{ type: 'run.state' as const, state: { ...fixture.snapshot.state.run, stopRequested: true } }] }
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(change, context.guard, async () => { throw new Error('forced-stop-rollback') })))).rejects.toThrow('GRAPH_INVALID_FACT')
    expect((await pool.query('select stop_requested_at from runs where id=$1', [fixture.scope.runId])).rows[0].stop_requested_at).toBeNull()
    expect(await reliabilityCounts(fixture)).toEqual({ head: '0', sources: 0, effects: 0, value: 0 })
    const launch = await effectContext(fixture)
    expect((await launch.perform('launch-after-rolled-back-stop')).publication.sequence).toBe('1')
  })
  it('serializes a real Stop/completion race on the parent lock, with no late-success resurrection', async () => {
    const fixture = await fresh(), context = await effectContext(fixture, 'run.stop', fixture.scope.runId)
    const entered = deferred(), release = deferred(), writer = await pool.connect()
    const change = { ...context.change('racing-stop'), facts: [{ type: 'run.state' as const, state: { ...fixture.snapshot.state.run, stopRequested: true } }] }
    let completion: Promise<pg.QueryResult> | undefined
    const stopping = withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(change, context.guard, async () => { entered.resolve(); await release.promise })))
    try {
      await entered.promise
      const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const record = { ...fixture.run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: fixture.createdAt }
      completion = writer.query("update runs set execution_state='completed',record=$2::jsonb where id=$1", [fixture.scope.runId, JSON.stringify(record)])
      void completion.catch(() => undefined)
      expect((await blocked(pid)).length).toBeGreaterThan(0)
      release.resolve(); await stopping
      await expect(completion).rejects.toMatchObject({ code: 'PGR01' })
    } finally { release.resolve(); await stopping; await completion?.catch(() => undefined); writer.release() }
    expect((await pool.query('select execution_state,stop_requested_at is not null as stopped from runs where id=$1', [fixture.scope.runId])).rows[0]).toEqual({ execution_state: 'queued', stopped: true })
    expect((await reliabilityCounts(fixture)).head).toBe('1')
  })

  it('rejects malformed complete effect facts and accepts later valid work on a new transaction', async () => {
    const fixture = await fresh(), context = await effectContext(fixture), called = vi.fn(mutate(fixture, 1))
    const malformed = { ...context.change('malformed-observation'), facts: [{ ...fact(fixture, 1), rawNativeBody: 'must-not-publish' } as unknown as GraphFact] }
    await expect(withExclusiveGraphConnection(pool, (connection) => withRunGraphPublication(connection, fixture.scope,
      (publication) => publication.effect(malformed, context.guard, called)))).rejects.toThrow('GRAPH_INVALID_FACT')
    expect(called).not.toHaveBeenCalled()
    expect(await reliabilityCounts(fixture)).toEqual({ head: '0', sources: 0, effects: 0, value: 0 })
    expect((await context.perform('valid-observation')).publication.sequence).toBe('1')
  })

})
