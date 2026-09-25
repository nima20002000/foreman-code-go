import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { canonicalGraphJson, type RepeatGraphScopeV3 } from '@graphql/contracts/wave25'
import { graphSourceDigest, openRunGraphPublication, type RunGraphPublication } from '../src/modules/run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../src/modules/run-graph/repeatReceipts.js'
import { readRepeatGraphPage } from '../src/modules/run-graph/repeatReader.js'
import { assertRepeatGraphCommittedState } from '../src/modules/run-graph/repeatProjectionProof.js'
import { repeatId } from '../src/modules/runs/repeatResolution.js'
import { ProjectionDatabase, projectionScope, projectionDigest, occurrenceFact, publicationInput } from './eng04-projection-fixture.js'

async function publish(db: ProjectionDatabase, count = 1) {
  const connection = db.connection()
  let publication!: RunGraphPublication<RepeatGraphScopeV3>
  try {
    await connection.transaction(async sql => {
      publication = await openRunGraphPublication(sql, projectionScope)
      for (let n = 0; n < count; n++) {
        const id = String(n), input = publicationInput(id)
        const result = await publication.repeatChange(input, db.owner,
          async transaction => { await transaction.query('update projection_test_domain set revision=revision+1') }, async () => [occurrenceFact(id)])
        requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: projectionScope, evidence: input.evidence,
          sourceDigest: input.sourceDigest, semanticDigest: result.semanticDigest,
          effect: { kind: input.effect.identity.kind, entityId: input.effect.identity.entityId, digest: input.effect.digest } })
        assert.throws(() => publication.receipt)
      }
    })
    return publication.receipt
  } finally { await connection.close() }
}
const request = (afterSequence: string) => ({ protocolVersion: 1, scope: projectionScope, afterSequence })
const allowRead = async () => undefined // SQL-model authorization callback; NOT application authorization.

describe('ENG04 existing journal, SQL-shaped only', () => {
  it('one transaction has one head and receipts are queried before COMMIT', async () => {
    const db = new ProjectionDatabase(), receipt = await publish(db, 2)
    assert.equal(receipt.kind, 'events'); assert.equal(db.state.head, 1); assert.equal(db.state.domain, 2)
    assert.equal(db.state.sources.length, 2); assert.equal(db.state.effects.length, 2)
    const insert = db.calls.findIndex(q => q.startsWith('insert into run_graph_effects'))
    const check = db.calls.findIndex(q => q.includes('join run_graph_sources s'))
    assert.ok(insert < check && check < db.calls.indexOf('commit'))
  })
  it('duplicate source/effect skips mutation and consumes no cursor', async () => {
    const db = new ProjectionDatabase(); await publish(db)
    assert.equal((await publish(db)).kind, 'none'); assert.equal(db.state.domain, 1); assert.equal(db.state.head, 1)
  })
  it('reset-on-oversize retains permanent receipts and exact replay after retention', async () => {
    const db = new ProjectionDatabase(); assert.equal((await publish(db, 65)).kind, 'reset')
    assert.equal(db.state.batches[0]!.payload, null); assert.equal(db.state.sources.length, 65); assert.equal(db.state.effects.length, 65)
    const barrier = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(barrier.kind, 'reset'); if (barrier.kind === 'reset') assert.equal(barrier.reason, 'atomic_change_too_large')
    db.state.floor = 1; db.state.batches = []
    assert.equal((await publish(db, 65)).kind, 'none'); assert.equal(db.state.head, 1); assert.equal(db.state.domain, 65)
    const expired = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(expired.kind, 'reset'); if (expired.kind === 'reset') assert.equal(expired.reason, 'history_expired')
  })
  it('a caught digest conflict still rolls the entire transaction back', async () => {
    const db = new ProjectionDatabase(); await publish(db); const before = structuredClone(db.state), c = db.connection()
    try { await assert.rejects(c.transaction(async sql => {
      const p = await openRunGraphPublication(sql, projectionScope)
      const wrong = { ...publicationInput('0'), sourceDigest: `sha256:${'b'.repeat(64)}` }
      await assert.rejects(p.repeatChange(wrong, db.owner, async () => undefined, async () => [occurrenceFact('0')]))
    })) } finally { await c.close() }
    assert.deepEqual(db.state, before)
  })
  it('Stop blocks a new effect before its mutation', async () => {
    const db = new ProjectionDatabase(); db.state.stopped = true
    await assert.rejects(publish(db)); assert.equal(db.state.head, 0); assert.equal(db.state.domain, 0); assert.ok(db.calls.includes('rollback'))
  })
  it('owner fence loss after publication writes rolls domain/head/receipts back', async () => {
    const db = new ProjectionDatabase(); db.onInsertSource = () => { db.ownerFence = '101' }
    await assert.rejects(publish(db)); assert.equal(db.state.head, 0); assert.equal(db.state.domain, 0); assert.equal(db.state.sources.length, 0)
  })
  it('missing committed effect proof is not repaired by a duplicate', async () => {
    const db = new ProjectionDatabase(); await publish(db); db.state.effects = []
    await assert.rejects(publish(db)); assert.equal(db.state.head, 1); assert.equal(db.state.domain, 1)
  })
  it('an unknown COMMIT reply does not return a receipt or retry work', async () => {
    const db = new ProjectionDatabase(); db.unknownCommit = true
    await assert.rejects(publish(db), /COMMIT reply lost/)
    assert.equal(db.state.head, 1); assert.equal(db.state.domain, 1)
    assert.equal((await publish(db)).kind, 'none'); assert.equal(db.state.domain, 1)
  })
  it('returns ordered complete batches, and current-head empty catch-up', async () => {
    const db = new ProjectionDatabase(); await publish(db)
    const page = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(page.kind, 'page'); if (page.kind === 'page') {
      assert.equal(page.throughSequence, '1'); assert.equal(page.batches[0]!.events.length, 1); assert.equal(page.hasMore, false)
    }
    const empty = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(empty.kind, 'page'); if (empty.kind === 'page') assert.equal(empty.batches.length, 0)
  })
  it('a schema-valid retained payload with a changed fact fails its permanent semantic proof', async () => {
    const db = new ProjectionDatabase(); await publish(db)
    const row = db.state.batches[0]!, body = JSON.parse(row.payload!)
    body.events[0].fact.occurrence.identity.occurrenceId = 'occ-x'
    row.payload = JSON.stringify(body); row.payload_bytes = Buffer.byteLength(row.payload!)
    const result = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(result.kind, 'reset'); if (result.kind === 'reset') assert.equal(result.reason, 'schema_changed')
  })
  it('a batch cannot reuse a source whose permanent first sequence does not match', async () => {
    const db = new ProjectionDatabase(); await publish(db)
    db.state.sources[0]!.first_sequence = '2'
    const result = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(result.kind, 'reset')
  })
  it('a hole never produces a partial delta', async () => {
    const db = new ProjectionDatabase(); await publish(db); db.state.head = 2; db.state.batches = []
    const result = await readRepeatGraphPage(db.pool(), request('0'), allowRead)
    assert.equal(result.kind, 'reset'); if (result.kind === 'reset') assert.equal(result.reason, 'gap')
  })
  it('rejects wrong physical pins and unknown semantics before mutation', async () => {
    for (const change of [{ workflowVersionId: 'other' }, { workspaceId: 'other' }, { executionSemanticsVersion: 4 }]) {
      const db = new ProjectionDatabase(); Object.assign(db.scope, change)
      await assert.rejects(publish(db)); assert.equal(db.state.domain, 0)
    }
    const db = new ProjectionDatabase()
    await assert.rejects(readRepeatGraphPage(db.pool(), { ...request('0'), scope: { ...projectionScope, executionSemanticsVersion: 4 } }, allowRead))
  })
  it('snapshot recovery requires committed Run metadata, including after payload reset/retention', async () => {
    const db = new ProjectionDatabase(), c = db.connection()
    const state = { run: { executionState: 'running' as const, outcome: 'pending' as const, stopRequested: false },
      occurrences: [], executions: [], results: [], bindings: [], resolutions: [], decisions: [] }
    try {
      await assert.rejects(c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '0', state), true))
      await c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, projectionScope)
        const sourceDigest = graphSourceDigest({ privateRunRecord: 'never public' })
        const evidence = { sourceKind: 'run' as const, sourceId: repeatId('repeat-run', projectionScope.runId, sourceDigest), sourceRevision: '1' }
        await p.repeatRunReadback({ evidence, sourceDigest }, db.owner, async () => [{ type: 'repeat.run.state', state: state.run }])
      })
      db.state.floor = 1; db.state.batches = []
      await c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '1', state), true)
      await assert.rejects(c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '1',
        { ...state, run: { ...state.run, stopRequested: true } }), true))
      assert.equal(db.state.head, 1)
    } finally { await c.close() }
  })
  it('late terminal evidence after Stop cannot be used to publish running work', async () => {
    const db = new ProjectionDatabase(); db.state.stopped = true; const c = db.connection()
    const execution = { identity: { workflowNodeId: 'outside', executionId: 'e', agentId: 'a', agentConfigurationVersionId: 'c', attempt: 1, occurrence: null },
      inputDigest: projectionDigest, previousExecutionId: null, state: 'completed' as const, resultOutcome: 'canceled' as const }
    try {
      await c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, projectionScope)
        await p.repeatObservation({ evidence: { sourceKind: 'execution', sourceId: 'native-terminal', sourceRevision: '1' }, sourceDigest: projectionDigest },
          db.owner, async () => undefined, async () => [{ type: 'repeat.execution', execution }])
      })
      await assert.rejects(c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, projectionScope)
        await p.repeatObservation({ evidence: { sourceKind: 'execution', sourceId: 'native-running', sourceRevision: '1' }, sourceDigest: projectionDigest },
          db.owner, async transaction => { await transaction.query('update projection_test_domain set revision=revision+1') },
          async () => [{ type: 'repeat.execution', execution: { ...execution, state: 'running', resultOutcome: null } }])
      }))
      assert.equal(db.state.head, 1); assert.equal(db.state.domain, 0)
    } finally { await c.close() }
  })
  it('read authorization failure does not read head or payload', async () => {
    const db = new ProjectionDatabase()
    await assert.rejects(readRepeatGraphPage(db.pool(), request('0'), async () => { throw new Error('denied') }))
    assert.ok(!db.calls.some(q => q.startsWith('select h.') || q.includes('from run_graph_batches')))
  })
  it('metadata journal never receives the private source body', async () => {
    const db = new ProjectionDatabase(); await publish(db)
    const wire = db.state.batches[0]!.payload!
    assert.ok(wire.includes(projectionDigest)); assert.ok(!/"(resultData|input_json|result_json|nativeSessionId|runtimeDirectory|prompt|credentials)"/.test(wire))
  })
  for (const semantics of [1, 2] as const) it(`preserves semantics ${semantics} source publication and duplicate behavior`, async () => {
    const db = new ProjectionDatabase(); db.scope.executionSemanticsVersion = semantics
    const c = db.connection(), scope = { ...projectionScope, executionSemanticsVersion: semantics }
    try {
      for (let n = 0; n < 2; n++) await c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, scope)
        await p.source({ evidence: { sourceKind: 'run', sourceId: 'legacy', sourceRevision: '1' }, sourceDigest: projectionDigest,
          facts: [{ type: 'run.state', state: { executionState: 'running', outcome: 'pending', stopRequested: false,
            cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 } }] },
        async transaction => { await transaction.query('update projection_test_domain set revision=revision+1') })
      })
      assert.equal(db.state.head, 1); assert.equal(db.state.domain, 1)
      assert.equal(JSON.parse(db.state.batches[0]!.payload!).scope.executionSemanticsVersion, semantics)
      assert.ok(!canonicalGraphJson(db.state.batches).includes('repeat.occurrence'))
    } finally { await c.close() }
  })
})
