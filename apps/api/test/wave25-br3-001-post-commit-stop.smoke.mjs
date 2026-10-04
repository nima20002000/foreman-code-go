/* global process, URL */
/** SOURCE/SYNTHETIC ONLY. Runs the actual cancellation method and its actual
 * selection/update SQL on an in-memory SQLite model. Publication, authority,
 * locks, contracts and receipt eligibility are substituted. This cannot qualify
 * PostgreSQL transactions, saver atomicity, native cleanup, parity or polling.
 *
 * Run from the repository root with Node >=22.16 and installed TypeScript:
 * node --test apps/api/test/wave25-br3-001-post-commit-stop.smoke.mjs
 * BR3_REPOSITORY_FILE may point to the original pinned file for a RED run.
 * TYPESCRIPT_MODULE_PATH is optional when TypeScript is not locally resolvable.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require(process.env.TYPESCRIPT_MODULE_PATH || 'typescript')
const repositoryFile = process.env.BR3_REPOSITORY_FILE
  || fileURLToPath(new URL('../src/modules/interactions/wave25/repository.ts', import.meta.url))
const source = readFileSync(repositoryFile, 'utf8')
const compiled = ts.transpileModule(source, { fileName: repositoryFile, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
assert.deepEqual(compiled.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])

function fixture({ status = 'delivered', state = 'resumed', ack = null, retired = false, allowed = true, v2 = true } = {}) {
  const db = new DatabaseSync(':memory:')
  db.function('clock_timestamp', () => '2026-09-23T00:00:00.000Z')
  db.exec(`create table durable_interactions(id text primary key, run_id text, status text, revision integer, record text,
    retired integer, delivery_fence integer, delivery_owner text, delivery_token text, delivery_lease_expires_at text);
    create table interaction_graph_resumes(interaction_id text, state text, approval_native_ack_id text, revision integer,
      lease_owner text,lease_token text,lease_expires_at text,updated_at text,completed_at text);
    create table interaction_delivery_attempts(interaction_id text,state text,lease_expires_at text,evidence text);`)
  const current = { id: 'approval', runId: 'run', revision: 7, status, deliveryState: 'delivered',
    deliveredAt: '2026-09-22T23:58:00.000Z', nativeResponse: { optionId: 'native-exact', semantic: 'approve_once' },
    graphThreadId: 'run', graphInterruptId: 'exact-interrupt', nativeRequestId: 'native-request',
    nativeSessionId: 'native-session', updatedAt: '2026-09-22T23:59:00.000Z' }
  db.prepare('insert into durable_interactions values(?,?,?,?,?,?,?,?,?,?)')
    .run(current.id, current.runId, current.status, current.revision, JSON.stringify(current), Number(retired), 3, null, null, null)
  if (state !== null) db.prepare('insert into interaction_graph_resumes values(?,?,?,?,?,?,?,?,?)')
    .run(current.id, state, ack, 5, null, null, null, current.updatedAt, current.updatedAt)
  db.prepare('insert into interaction_delivery_attempts values(?,?,?,?)')
    .run(current.id, 'delivered', null, JSON.stringify({ nativeRequestId: current.nativeRequestId, receipt: 'exact-delivery' }))
  const sources = [], retirementVisits = [], calls = []
  const all = (table) => db.prepare(`select * from ${table}`).all().map((row) => ({ ...row }))
  const sql = { query: async (text, values = []) => {
    calls.push(text)
    const statement = db.prepare(text)
    const parameters = Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]))
    if (/^\s*select\b/i.test(text)) { const rows = statement.all(parameters); return { rows, rowCount: rows.length } }
    return { rows: [], rowCount: Number(statement.run(parameters).changes) }
  } }
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  const imports = {
    '@foreman-code/contracts/wave25': { canonicalGraphJson: JSON.stringify },
    '../postgres.js': { PostgresInteractionRepository: class { async cancelPendingForRun() { return 123 } } },
    './reviews.js': { Wave25InteractionCoordinationRepository: class {} },
    './delivery.js': { Wave25InteractionDeliveryRepository: class {} },
    './decisions.js': {},
    './cleanupAuthority.js': { runCleanupAllowed: async () => allowed },
    './context.js': { fail, isV2: async () => v2,
      transact: async (_pool, _run, work) => work({ sql }),
      lockInteraction: async (_sql, id) => JSON.parse(db.prepare('select record from durable_interactions where id=?').get(id).record),
      readContext: async () => ({ stopped: true }) },
    './publication.js': {
      // Receipt eligibility is modeled, NOT reimplemented or certified here.
      CANCELED_INTERACTION_RETIRED_SQL: 'i.retired=1',
      nextInteraction: (before, fields) => ({ ...before, ...fields, revision: before.revision + 1, updatedAt: '2026-09-23T00:00:00.000Z' }),
      retireCanceledInteraction: async (_publication, _context, value) => { retirementVisits.push(value.id) },
      publishInteraction: async (_publication, _context, before, next, options) => {
        assert.equal(next.revision, before.revision + 1)
        db.prepare('update durable_interactions set status=?,revision=?,record=? where id=?')
          .run(next.status, next.revision, JSON.stringify(next), next.id)
        sources.push({ next, resumeState: options.resumeState })
        await options.mutate(sql)
      },
    },
  }
  const module = { exports: {} }
  const controlledRequire = (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected runtime dependency: ${name}`)
    return imports[name]
  }
  new Function('require', 'module', 'exports', compiled.outputText)(controlledRequire, module, module.exports)
  const repository = new module.exports.Wave25InteractionRepository({})
  const record = () => JSON.parse(all('durable_interactions')[0].record)
  return { db, repository, all, sources, retirementVisits, calls, record, current }
}

for (const state of ['resumed', 'pending', 'resuming', 'blocked', 'canceled', null]) {
  test(`unacknowledged delivered row is negatively selected with outbox=${state}`, async () => {
    const f = fixture({ state })
    try {
      const outbox = f.all('interaction_graph_resumes'), attempt = f.all('interaction_delivery_attempts')
      assert.equal(await f.repository.cancelPendingForRun('run'), 1)
      assert.deepEqual(f.record(), { ...f.current, status: 'canceled', revision: 8, updatedAt: '2026-09-23T00:00:00.000Z' })
      assert.equal(f.sources[0].resumeState, 'unknown')
      assert.deepEqual(f.all('interaction_delivery_attempts'), attempt)
      if (state === 'resumed') assert.deepEqual(f.all('interaction_graph_resumes'), outbox)
      else if (state !== null) {
        assert.equal(f.all('interaction_graph_resumes')[0].state, 'canceled')
        assert.equal(f.all('interaction_graph_resumes')[0].approval_native_ack_id, null)
      }
      assert.equal(await f.repository.cancelPendingForRun('run'), 0)
      assert.equal(f.sources.length, 1)
      assert.deepEqual(f.retirementVisits, ['approval'])
    } finally { f.db.close() }
  })
}
for (const state of ['resumed', 'pending']) {
  test(`a present acknowledgement ID remains exempt (outbox=${state})`, async () => {
    const f = fixture({ state, ack: 'continuation-ack-exact' })
    try {
      const before = f.all('durable_interactions'), outbox = f.all('interaction_graph_resumes')
      assert.equal(await f.repository.cancelPendingForRun('run'), 0)
      assert.deepEqual(f.all('durable_interactions'), before)
      assert.deepEqual(f.all('interaction_graph_resumes'), outbox)
      assert.equal(f.sources.length, 0)
    } finally { f.db.close() }
  })
}
test('an unretired canceled exchange is revisited without changing its revision or committed outbox', async () => {
  const f = fixture({ status: 'canceled' })
  try {
    const before = f.all('durable_interactions'), outbox = f.all('interaction_graph_resumes')
    assert.equal(await f.repository.cancelPendingForRun('run'), 0)
    assert.deepEqual(f.retirementVisits, ['approval'])
    assert.deepEqual(f.all('durable_interactions'), before)
    assert.deepEqual(f.all('interaction_graph_resumes'), outbox)
    assert.equal(f.sources.length, 0)
  } finally { f.db.close() }
})
test('an already retired canceled exchange is a no-op', async () => {
  const f = fixture({ status: 'canceled', retired: true })
  try {
    assert.equal(await f.repository.cancelPendingForRun('run'), 0)
    assert.deepEqual(f.retirementVisits, [])
    assert.equal(f.sources.length, 0)
  } finally { f.db.close() }
})
test('negative authority still gates the entire v2 method', async () => {
  const f = fixture({ allowed: false })
  try {
    await assert.rejects(f.repository.cancelPendingForRun('run'), { code: 'EXECUTION_NOT_STOPPED' })
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.record(), f.current)
  } finally { f.db.close() }
})
test('semantics-1 still delegates without executing v2 SQL', async () => {
  const f = fixture({ v2: false })
  try {
    assert.equal(await f.repository.cancelPendingForRun('run'), 123)
    assert.equal(f.calls.length, 0)
  } finally { f.db.close() }
})
