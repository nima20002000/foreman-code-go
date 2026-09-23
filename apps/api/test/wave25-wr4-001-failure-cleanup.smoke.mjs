/* global process, URL, structuredClone */
/** Dependency-free WR4-001 caller-seam checks (Node >=22.13).
 * Executes the actual failExecution method body and unchanged lifecycle mapper.
 * Transaction, schema, projection, publication, resolution and SQL ports below
 * are SYNTHETIC. This is NOT PostgreSQL, native, graph-schema or web-reducer
 * qualification; the adjacent opt-in integration suite owns those assertions.
 * WR4_SOURCE_ROOT selects a source tree for baseline/mutation controls only.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = process.env.WR4_SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const source = await readFile(resolve(root, 'apps/api/src/modules/runs/oneShotPostgres.ts'), 'utf8')
const begin = source.indexOf('  async failExecution(')
const end = source.indexOf('\n  async updateRun(', begin)
assert.ok(begin >= 0 && end > begin, 'Could not locate the complete production failure method')
const method = source.slice(begin, end)
const lifecycle = await readFile(resolve(root, 'apps/api/src/modules/run-graph/publicLifecycle.ts'), 'utf8')
const lifecycleJs = stripTypeScriptTypes(lifecycle).replace(/^export /gm, '')
const publicNodeLifecycle = new Function(`${lifecycleJs}\nreturn publicNodeLifecycle`)()
const methodJs = stripTypeScriptTypes(`class FailureProducer {\n${method}\n}`)
const identity = (execution) => ({ workflowNodeId: execution.workflowNodeId, executionId: execution.id,
  agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId, attempt: execution.attempt })
const copy = (value) => structuredClone(value)

function fixture(options = {}) {
  const run = { id: 'run', executionState: options.terminalRun ?? 'running', outcome: 'pending' }
  const scope = { runId: 'run', workflowVersionId: 'version', workspaceId: 'workspace', workflowId: 'workflow', executionSemanticsVersion: 2 }
  const rows = new Map(['a', 'b'].map((id) => [id, { accepted: false, execution: {
    id, workflowNodeId: `node-${id}`, runId: run.id, agentId: `agent-${id}`, agentConfigurationVersionId: `config-${id}`,
    attempt: 1, state: 'starting', nativeSessionId: `native-${id}`, input: { exact: id }, createdAt: '2026-09-21T00:00:00.000Z',
  } }]))
  const resolutions = new Map(), projections = [], publications = [], writes = []
  const native = ['a', 'b'].map((id) => ({ executionId: id, session: `native-${id}`, connection: `connection-${id}`,
    generation: '1', sequence: 0, acknowledgementId: `raw-start-${id}` }))
  let cleanup = options.cleanupPending ?? false
  if (options.completed) Object.assign(rows.get('a').execution, { state: 'completed', finishedAt: '2026-09-22T00:00:00.000Z',
    result: { outcome: options.completed, ...(options.completed === 'failed' ? { error: { code: 'ORIGINAL', message: 'Original', retryable: false } } : {}) } })
  if (options.accepted) rows.get('a').accepted = true
  if (options.resolved) resolutions.set('node-a', { workflowNodeId: 'node-a', resolution: 'failed' })
  if (options.missing) rows.delete('a')
  const sql = { query: async (text, params) => {
    if (text.startsWith('update harness_executions set record=')) {
      writes.push('execution'); rows.get(params[0]).execution = JSON.parse(params[1])
    } else if (text.startsWith('insert into run_cleanup_intents')) {
      writes.push('cleanup'); cleanup = true
    } else throw new Error(`Unexpected synthetic SQL: ${text}`)
    return { rows: [], rowCount: 1 }
  } }
  const context = { sql, scope, run, stopped: options.stopped ?? false, executions: rows, resolutions,
    version: { definition: { nodes: [{ id: 'node-a' }, { id: 'node-b' }, { id: 'not-yet-selected' }] } } }
  const project = async (transaction, requestedScope, ids, overlay) => {
    assert.equal(transaction, sql); assert.equal(requestedScope, scope)
    projections.push({ ids: [...ids], overlay: copy(overlay), writes: writes.length })
    if (options.projectionError) throw new Error('projection failed')
    const closed = context.stopped || ['completed', 'interrupted'].includes(run.executionState)
      || (overlay?.cleanupPending ?? cleanup)
    return ids.map((id) => {
      const execution = overlay?.executions?.find((item) => item.workflowNodeId === id)
        ?? [...rows.values()].find((item) => item.execution.workflowNodeId === id)?.execution
      const acknowledged = { workflowNodeId: id, status: 'active', action: 'working', acknowledgementId: `ack-${id}`, correlationId: `turn-${id}` }
      const state = { workflowNodeId: id,
        lifecycle: publicNodeLifecycle(execution?.state, execution?.result?.outcome, resolutions.get(id)?.resolution,
          { closed, native: acknowledged }), ...(execution ? { execution: identity(execution) } : {}) }
      const activity = closed || execution?.state === 'completed' ? { workflowNodeId: id, status: 'none' }
        : execution ? acknowledged : { workflowNodeId: id, status: 'unknown' }
      return { state, activity }
    })
  }
  const delta = (before, after) => after.flatMap((node) => {
    const old = before.find((item) => item.state.workflowNodeId === node.state.workflowNodeId)
    return [['state', 'node.state'], ['activity', 'node.activity']].flatMap(([key, type]) =>
      JSON.stringify(old?.[key]) === JSON.stringify(node[key]) ? [] : [{ type, [key]: copy(node[key]) }])
  })
  const dependencies = {
    HarnessExecutionSchema: { parse: copy },
    oneShotResolution: (_version, execution) => ({ workflowNodeId: execution.workflowNodeId,
      execution: identity(execution), resolution: execution.result.outcome, selectedRelationshipIds: [], unselectedRelationshipIds: [],
      branchEnded: false, resolvedAt: execution.finishedAt }),
    readOneShotRunState: async () => ({ ...run, stopRequested: context.stopped, cleanupPending: cleanup }),
    readPublicNodeProjection: project,
    publicNodeProjectionDelta: delta,
    putNodeResolution: async (_sql, _scope, resolution) => { writes.push('resolution'); resolutions.set(resolution.workflowNodeId, copy(resolution)) },
    conflict: (code) => { const error = new Error(code); error.code = code; throw error },
  }
  const Producer = new Function(...Object.keys(dependencies), `${methodJs}\nreturn FailureProducer`)(...Object.values(dependencies))
  const producer = new Producer()
  producer.transaction = async (work) => work(context)
  const publish = async (kind, entityId, value, facts, mutate) => {
    assert.deepEqual(writes, [], 'The caller must not mutate before its publication port')
    if (options.denyPublication) throw new Error('publication denied')
    publications.push({ kind, entityId, value: copy(value), facts: copy(facts) })
    await mutate(sql)
  }
  producer.effect = async (_context, kind, entityId, value, facts, mutate) => publish(kind, entityId, value, facts, mutate)
  producer.source = async (_context, kind, entityId, value, facts, mutate) => publish(`source:${kind}`, entityId, value, facts, mutate)
  return { producer, context, rows, native, projections, publications, writes, cleanup: () => cleanup }
}

for (const canceled of [false, true]) {
  test(`${canceled ? 'canceled' : 'failed'} computes all pinned nodes with both proposed overlays, once, before mutation`, async () => {
    const f = fixture(), originalNative = copy(f.native), b = copy(f.rows.get('b'))
    await f.producer.failExecution('a', 'ABNORMAL', canceled)
    assert.equal(f.projections.length, 2)
    for (const call of f.projections) {
      assert.deepEqual(call.ids, ['node-a', 'node-b', 'not-yet-selected'])
      assert.equal(call.writes, 0)
    }
    assert.equal(f.projections[0].overlay, undefined)
    assert.equal(f.projections[1].overlay.cleanupPending, true)
    assert.equal(f.projections[1].overlay.executions.length, 1)
    assert.equal(f.projections[1].overlay.executions[0].id, 'a')
    assert.equal(f.projections[1].overlay.executions[0].result.outcome, canceled ? 'canceled' : 'failed')
    assert.equal(f.publications.length, 1)
    const publication = f.publications[0]
    assert.equal(publication.kind, 'route.resolve')
    assert.equal(publication.entityId, 'node-a')
    const states = publication.facts.filter((fact) => fact.type === 'node.state')
    assert.equal(states.length, 2)
    assert.equal(states.find((fact) => fact.state.workflowNodeId === 'node-a').state.lifecycle, canceled ? 'canceled' : 'failed')
    assert.equal(states.find((fact) => fact.state.workflowNodeId === 'node-b').state.lifecycle, 'unknown')
    assert.deepEqual(publication.facts.find((fact) => fact.type === 'node.activity' && fact.activity.workflowNodeId === 'node-b'),
      { type: 'node.activity', activity: { workflowNodeId: 'node-b', status: 'none' } })
    const state = publication.facts.find((fact) => fact.type === 'run.state').state
    assert.equal(state.stopRequested, false); assert.equal(state.cleanupPending, true)
    assert.equal(state.outcome, 'pending')
    assert.equal(publication.facts.some((fact) => ['worker.resumed', 'input.bound', 'result.accepted'].includes(fact.type)), false)
    assert.deepEqual(f.rows.get('b'), b); assert.deepEqual(f.native, originalNative)
    assert.deepEqual(f.writes, ['execution', 'resolution', 'cleanup'])
    assert.equal(f.cleanup(), true)
    await f.producer.failExecution('a', 'MUST_NOT_REWRITE', !canceled)
    assert.equal(f.publications.length, 1); assert.equal(f.projections.length, 2)
  })
}
for (const options of [{ stopped: true }, { terminalRun: 'completed' }, { terminalRun: 'interrupted' }]) {
  test(`closed context ${JSON.stringify(options)} preserves negative source, not route-effect authority`, async () => {
    const f = fixture(options)
    await f.producer.failExecution('a', 'CLOSED', true)
    assert.equal(f.publications.length, 1)
    assert.equal(f.publications[0].kind, 'source:execution')
    assert.equal(f.publications[0].entityId, 'a')
    assert.equal(f.publications[0].facts.some((fact) => fact.type === 'node.state' && fact.state.lifecycle === 'running'), false)
    assert.equal(f.projections[1].overlay.cleanupPending, true)
  })
}
test('already-pending cleanup still combines the failed execution with the whole-Run overlay', async () => {
  const f = fixture({ cleanupPending: true })
  await f.producer.failExecution('a', 'ABNORMAL')
  assert.deepEqual(f.projections[1].ids, ['node-a', 'node-b', 'not-yet-selected'])
  assert.equal(f.projections[1].overlay.cleanupPending, true)
  assert.equal(f.publications[0].facts.filter((fact) => fact.type === 'node.state').length, 1)
  assert.equal(f.publications[0].facts.find((fact) => fact.type === 'node.state').state.lifecycle, 'failed')
})
for (const completed of ['failed', 'canceled']) {
  test(`saved ${completed} terminal remains byte-for-byte authoritative despite opposite caller disposition`, async () => {
    const f = fixture({ completed }), original = copy(f.rows.get('a').execution)
    await f.producer.failExecution('a', 'REPLACEMENT', completed !== 'canceled')
    assert.deepEqual(f.rows.get('a').execution, original)
    assert.equal(f.publications[0].value.resolution, completed)
    assert.equal(f.projections[1].overlay.cleanupPending, true)
  })
}
for (const [label, options] of [['missing', { missing: true }], ['already resolved', { resolved: true }], ['saved success', { completed: 'succeeded' }]]) {
  test(`${label} returns without projections, mutation, cleanup or publication`, async () => {
    const f = fixture(options)
    await f.producer.failExecution('a', 'ABNORMAL', true)
    assert.deepEqual(f.projections, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.publications, [])
    assert.equal(f.cleanup(), false)
  })
}
test('accepted work rejects before projection and mutation', async () => {
  const f = fixture({ accepted: true })
  await assert.rejects(f.producer.failExecution('a', 'ABNORMAL'), { code: 'EXECUTION_ACCEPTED_RESULT_CONFLICT' })
  assert.deepEqual(f.projections, []); assert.deepEqual(f.writes, []); assert.equal(f.cleanup(), false)
})
test('publication port denial prevents the producer mutation callback', async () => {
  const f = fixture({ denyPublication: true }), original = copy([...f.rows])
  await assert.rejects(f.producer.failExecution('a', 'ABNORMAL'), /publication denied/)
  assert.deepEqual(f.writes, []); assert.deepEqual([...f.rows], original); assert.equal(f.cleanup(), false)
})
test('projection failure prevents effect/source entry and writes', async () => {
  const f = fixture({ projectionError: true })
  await assert.rejects(f.producer.failExecution('a', 'ABNORMAL'), /projection failed/)
  assert.deepEqual(f.publications, []); assert.deepEqual(f.writes, []); assert.equal(f.cleanup(), false)
})
