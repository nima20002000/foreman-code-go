import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { GraphFact, RunGraphSnapshot } from '@graphql/contracts/wave25'
import { createPostgresFixture, postgresEnabled, seedGraph, type SeededGraph, type PostgresFixture } from './postgresFixture.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { withRunGraphPublication, graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { appendNativeGraphEvent } from '../../src/modules/run-graph/nativeIngestion.js'
import { prepareNativeGraphClear } from '../../src/modules/run-graph/nativeClear.js'
import { createCompactSnapshotAssembler } from '../../src/modules/run-graph/compactSnapshot.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { qualifyLongHistory } from './queryQualification.js'

const principal = (f: SeededGraph) => ({ id: 'a5-test-reader', name: 'Synthetic reader', audience: 'operator' as const,
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['runs:read' as const], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.scope.runId] } }] })
const request = (f: SeededGraph) => ({ protocolVersion: 1, scope: f.scope })
const native = (f: SeededGraph, sequence: number, type = 'commandExecution') => ({ executionId: f.key.workId,
  connectionId: f.connectionId, sequence, type: 'item.started', occurredAt: f.createdAt,
  payload: { threadId: f.nativeSessionId, turnId: f.nativeTurnId, item: { id: `tool-${sequence}`, type,
    commandActions: [{ type: 'read' }], status: 'inProgress', arguments: { credential: 'SECRET-PROBE', path: '/private/SECRET-PROBE' }, output: 'SECRET-PROBE' } } })
function apply(snapshot: RunGraphSnapshot, facts: readonly GraphFact[]) {
  for (const fact of facts) {
    if (fact.type === 'run.state') snapshot.state.run = fact.state
    if (fact.type === 'node.activity') snapshot.state.nodes.find((node) => node.state.workflowNodeId === fact.activity.workflowNodeId)!.activity = fact.activity
    if (fact.type === 'node.attention') snapshot.state.nodes.find((node) => node.state.workflowNodeId === fact.attention.workflowNodeId)!.attention = fact.attention
  }
}

describe.skipIf(!postgresEnabled)('A5 real PostgreSQL: primary cuts, publication, auth and long-history reads', () => {
  let db: PostgresFixture, reads: RunGraphReadService
  beforeAll(async () => {
    db = await createPostgresFixture()
    // S1 has no Agent 4 finalized producers. This EXPLICIT fixture has zero interactions;
    // production registration must supply its current, authorized domain reader.
    reads = new RunGraphReadService(db.pool, createCompactSnapshotAssembler(async () => ({ interactions: [], reviews: [] })), { qualifiedReads: true })
  }, 60000)
  afterAll(async () => { if (db) await db.close() })
  const publish = (f: SeededGraph, sequence: number, type = 'commandExecution') => withExclusiveGraphConnection(db.pool,
    (connection) => withRunGraphPublication(connection, f.scope, (publication) => appendNativeGraphEvent(publication,
      native(f, sequence, type), [{ guard: f.guard, correlationKey: 'fixture-submission' }])))

  it('persists activity once; exact raw duplicate leaves graph cursor and checkpoint unchanged', async () => {
    const f = await seedGraph(db.pool)
    await publish(f, 1)
    const first = await reads.snapshot(principal(f), request(f))
    const repeated = await publish(f, 1)
    expect(repeated.value.rawInserted).toBe(false)
    expect(await reads.snapshot(principal(f), request(f))).toEqual(first)
    expect(first.state.nodes[0]!.activity.action).toBe('reading_file')
    expect(JSON.stringify(first)).not.toContain('SECRET-PROBE')
  })

  it('authorizes the actual tuple, rejects wrong pins, App authority, expired grants and unknown protocol', async () => {
    const f = await seedGraph(db.pool), p = principal(f)
    const denied = { ...p, grants: [{ actions: ['runs:read' as const], scope: { workspaceIds: ['other-workspace'] } }] }
    await expect(reads.snapshot(denied, request(f))).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    await expect(reads.snapshot(p, { ...request(f), scope: { ...f.scope, workflowId: 'other-workflow' } })).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    await expect(reads.snapshot({ ...p, audience: 'worker', agentId: f.key.execution.agentId }, request(f))).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    await expect(reads.snapshot({ ...p, expiresAt: '2000-01-01T00:00:00.000Z' }, request(f))).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    await expect(reads.snapshot(p, { ...request(f), protocolVersion: 99 })).rejects.toMatchObject({ code: 'GRAPH_UNSUPPORTED_PROTOCOL' })
  })

  it('independent writers serialize Run publication while readers see an older coherent cut', async () => {
    const f = await seedGraph(db.pool), before = await reads.snapshot(principal(f), request(f))
    let release!: () => void, locked!: () => void
    const lockHeld = new Promise<void>((resolve) => { locked = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    // Test-only barrier models an in-flight SQL writer; there are NO native/network calls in production transactions.
    const first = withExclusiveGraphConnection(db.pool, (connection) => withRunGraphPublication(connection, f.scope, async (publication) => {
      const result = await appendNativeGraphEvent(publication, native(f, 1), [{ guard: f.guard, correlationKey: 'fixture-submission' }])
      locked(); await barrier; return result
    }))
    try {
      await Promise.race([lockHeld, first.then(() => { throw new Error('Writer completed before test barrier') })])
      const second = publish(f, 2, 'fileChange')
      const during = await reads.snapshot(principal(f), request(f))
      expect(during).toEqual(before)
      release(); await Promise.all([first, second])
      const after = await reads.snapshot(principal(f), request(f))
      expect(BigInt(after.asOfSequence)).toBe(BigInt(before.asOfSequence) + 2n)
      expect(after.state.nodes[0]!.activity.action).toBe('writing_file')
    } finally { release(); await first }
  })

  it('paginates complete batches without skipping ranges and snapshot + deltas equal a fresh snapshot', async () => {
    const f = await seedGraph(db.pool), before = await reads.snapshot(principal(f), request(f))
    for (let i = 1; i <= 35; i++) await publish(f, i, i % 2 ? 'commandExecution' : 'fileChange')
    const applied = structuredClone(before), seen = new Set<string>()
    let cursor = before.asOfSequence, pages = 0
    while (true) {
      const page = await reads.events(principal(f), { ...request(f), afterSequence: cursor })
      expect(page.kind).toBe('page'); if (page.kind !== 'page') throw new Error('Unexpected reset')
      expect(page.baseSequence).toBe(cursor); expect(page.batches.length).toBeLessThanOrEqual(16)
      for (const batch of page.batches) {
        expect(seen.has(batch.sequence)).toBe(false); seen.add(batch.sequence)
        expect(batch.events.length).toBeGreaterThan(0)
        apply(applied, batch.events.map((entry) => entry.fact))
      }
      cursor = page.throughSequence; pages++
      if (!page.hasMore) break
    }
    expect(pages).toBeGreaterThan(1); expect(seen.size).toBe(35)
    applied.asOfSequence = cursor
    expect(applied).toEqual(await reads.snapshot(principal(f), request(f)))
    expect(JSON.stringify(applied)).not.toContain('SECRET-PROBE')
  })

  it('retains exact decimal cursors above 2^53 and explicitly resets ahead/expired cursors', async () => {
    const f = await seedGraph(db.pool), base = '9007199254740993'
    // Deliberate fixture-only counter positioning; never used by production code.
    await db.pool.query('update run_graph_heads set head_sequence=$2::bigint,retention_floor=$2::bigint where run_id=$1', [f.run.id, base])
    await publish(f, 1)
    const page = await reads.events(principal(f), { ...request(f), afterSequence: base })
    expect(page.kind).toBe('page')
    if (page.kind === 'page') expect(page.throughSequence).toBe('9007199254740994')
    const ahead = await reads.events(principal(f), { ...request(f), afterSequence: '9007199254740995' })
    expect(ahead).toMatchObject({ kind: 'reset', reason: 'cursor_ahead' })
    expect(await reads.events(principal(f), { ...request(f), afterSequence: '0' })).toMatchObject({ kind: 'reset', reason: 'history_expired' })
    await expect(reads.events(principal(f), { ...request(f), afterSequence: '01' })).rejects.toMatchObject({ code: 'GRAPH_INVALID_CURSOR' })
  })

  it('stale owner/fence/generation cannot append raw history or advance a cursor', async () => {
    for (const update of ["ownership='lost'", 'fence=2', 'generation=2', "access='observe'"]) {
      const f = await seedGraph(db.pool), before = await reads.snapshot(principal(f), request(f))
      await db.pool.query(`update a5_fixture_owners set ${update} where run_id=$1`, [f.run.id])
      await expect(publish(f, 1)).rejects.toThrow()
      expect(await reads.snapshot(principal(f), request(f))).toEqual(before)
      expect((await db.pool.query('select 1 from harness_native_events where execution_id=$1 and source_sequence=1', [f.key.workId])).rowCount).toBe(0)
    }
  })

  it('oversized structured evidence is rejected as a whole and does not poison the next event', async () => {
    const f = await seedGraph(db.pool), bad = native(f, 1)
    const original = { ...bad, payload: { ...bad.payload, item: { ...bad.payload.item, server: 'x'.repeat(40000) } } }
    const result = await withExclusiveGraphConnection(db.pool, (connection) => withRunGraphPublication(connection, f.scope,
      (publication) => appendNativeGraphEvent(publication, original, [{ guard: f.guard, correlationKey: 'fixture-submission' }])))
    expect(result.value.rejected).toBe(1)
    await publish(f, 2)
    expect((await reads.snapshot(principal(f), request(f))).state.nodes[0]!.activity.action).toBe('reading_file')
  })

  it('Stop clears activity in the same batch without claiming native closure; late native frames do not resurrect it', async () => {
    const f = await seedGraph(db.pool); await publish(f, 1)
    const before = await reads.snapshot(principal(f), request(f))
    await withExclusiveGraphConnection(db.pool, (connection) => withRunGraphPublication(connection, f.scope, async (publication) => {
      const state = { ...before.state.run, stopRequested: true }
      await publication.source({ evidence: { sourceKind: 'run', sourceId: f.run.id, sourceRevision: '1' },
        sourceDigest: graphSourceDigest(state), facts: [{ type: 'run.state', state }] },
      () => publication.sql.query('update runs set stop_requested_at=now() where id=$1', [f.run.id]))
      const clear = await prepareNativeGraphClear(publication, [f.guard], { runClosed: true })
      await publication.source({ evidence: { sourceKind: 'cleanup', sourceId: `clear-${f.run.id}`, sourceRevision: '1' },
        sourceDigest: graphSourceDigest(clear.facts), facts: clear.facts }, clear.apply)
    }))
    const stopped = await reads.snapshot(principal(f), request(f))
    expect(stopped.state.nodes.every((node) => node.activity.status === 'none')).toBe(true)
    await publish(f, 2, 'fileChange')
    expect(await reads.snapshot(principal(f), request(f))).toEqual(stopped)
    const nativeFence = (await db.pool.query('select terminal_native_sequence from run_native_activity where run_id=$1', [f.run.id])).rows[0]
    expect(nativeFence.terminal_native_sequence).toBeNull()
  })

  it.skipIf(process.env.RUN_WAVE25_A5_LONG_HISTORY !== '1')('preseeds 100k raw events; records EXPLAIN, read samples and relation growth', async () => {
    const f = await seedGraph(db.pool); await publish(f, 1)
    const report = await qualifyLongHistory(db.pool, f, () => reads.snapshot(principal(f), request(f)))
    expect(report.rawHistoryRows).toBe(100000)
    expect(report.plans.every((plan) => !plan.relations.some((name) => ['run_activity', 'harness_native_events'].includes(name)))).toBe(true)
  }, 120000)
})
