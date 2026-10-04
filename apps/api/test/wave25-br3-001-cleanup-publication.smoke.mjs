/* global process, URL, structuredClone */
/** SOURCE/SYNTHETIC ONLY. Real cleanup producer, node projection, native selector,
 * current-activity reader and approvalAttentionFacts; SQL runs on a translated
 * in-memory SQLite fixture. Locks, graph publication, schema parsing and Run
 * read assembly are substituted. The exact native-source superRefine callback
 * is extracted from the unchanged contract; this is NOT full Zod validation.
 * Node-field replay below is NOT the complete graph reference consumer. The
 * companion PostgreSQL/saver test retains the complete consumer and real schema.
 *
 * From repository root, with existing TypeScript (no installation required):
 * node --test apps/api/test/wave25-br3-001-cleanup-publication.smoke.mjs
 * BR3_SOURCE_ROOT may point at the preceding ZIP result for a RED run.
 * TYPESCRIPT_MODULE_PATH and BR3_PROTOCOL_FILE optionally locate existing inputs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require(process.env.TYPESCRIPT_MODULE_PATH || 'typescript')
const root = resolve(process.env.BR3_SOURCE_ROOT || fileURLToPath(new URL('../../..', import.meta.url)))
const modules = resolve(root, 'apps/api/src/modules')
const protocol = process.env.BR3_PROTOCOL_FILE || resolve(root, 'packages/contracts/src/wave25/protocol.ts')
const compile = (source, filename) => {
  const output = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  assert.deepEqual(output.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
  return output.outputText
}
const parsed = ts.createSourceFile(protocol, readFileSync(protocol, 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = parsed.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])
  .find((d) => d.name.getText(parsed) === 'RunGraphEventContentSchema')
assert.ok(declaration && ts.isCallExpression(declaration.initializer), 'Missing actual event-content schema')
const callback = declaration.initializer.arguments[0]
assert.ok(callback && ts.isArrowFunction(callback), 'Missing actual native-evidence refinement')
const callbackModule = { exports: {} }
new Function('module', compile(`module.exports = (${callback.getText(parsed)});`, 'refinement.ts'))(callbackModule)
const validateNativeSource = (evidence, facts) => {
  for (const fact of facts) {
    const issues = []
    callbackModule.exports({ evidence, fact }, { addIssue: (issue) => issues.push(issue) })
    assert.deepEqual(issues, [], 'actual native-source refinement rejects the proposed publication')
  }
}
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const digest = (value) => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex')
class FixtureError extends Error { constructor(code) { super(code); this.code = code } }

function fixture({ status = 'delivered', native = true, stopped = false, executionState = 'waiting' } = {}) {
  const db = new DatabaseSync(':memory:')
  db.function('now', () => '2026-09-23T00:00:00.000Z')
  db.exec(`create table runs(id text primary key,execution_state text,stop_requested_at text,record text);
    create table harness_executions(id text,run_id text,workflow_node_id text,attempt integer,record text);
    create table workflow_versions(id text,record text);
    create table durable_interactions(id text,run_id text,execution_id text,status text,record text);
    create table interaction_graph_resumes(interaction_id text,approval_native_ack_id text);
    create table review_jobs(id text,execution_id text,interaction_id text,state text,record text);
    create table run_cleanup_intents(run_id text primary key,pending integer default 1,attempts integer default 0,last_error text,updated_at text);
    create table run_graph_heads(run_id text,head_sequence integer);
    create table run_native_activity(run_id text,execution_id text,workflow_node_id text,attempt integer,work_kind text,work_id text,
      activity text,last_native_sequence integer,terminal_native_sequence integer,projection_revision integer);`)
  const scope = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', workflowVersionId: 'version', executionSemanticsVersion: 2 }
  const execution = { workflowNodeId: 'node', executionId: 'execution', agentId: 'worker', agentConfigurationVersionId: 'configuration', attempt: 1 }
  const run = { id: 'run', executionState, outcome: executionState === 'completed' ? 'canceled' : 'pending' }
  const interaction = { id: 'approval', runId: 'run', executionId: 'execution', status: status || 'delivered', deliveryState: 'delivered', revision: 7 }
  db.prepare('insert into runs values(?,?,?,?)').run('run', executionState, stopped ? '2026-09-23T00:00:00.000Z' : null, JSON.stringify(run))
  db.prepare('insert into harness_executions values(?,?,?,?,?)').run('execution', 'run', 'node', 1,
    JSON.stringify({ agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId, state: 'running' }))
  db.prepare('insert into workflow_versions values(?,?)').run('version', JSON.stringify({ definition: { nodes: [{ id: 'node' }] } }))
  db.prepare('insert into run_graph_heads values(?,?)').run('run', 0)
  if (status) {
    db.prepare('insert into durable_interactions values(?,?,?,?,?)').run('approval', 'run', 'execution', status, JSON.stringify(interaction))
    db.prepare('insert into interaction_graph_resumes values(?,?)').run('approval', null)
  }
  if (native) db.prepare('insert into run_native_activity values(?,?,?,?,?,?,?,?,?,?)').run('run', 'execution', 'node', 1, 'workflow', 'execution',
    JSON.stringify({ workflowNodeId: 'node', status: 'active', action: 'working', execution,
      correlationId: 'start-correlation', acknowledgementId: 'start-ack-not-continuation' }), 1, null, 0)
  const rawNative = () => db.prepare('select * from run_native_activity').all().map((row) => ({ ...row }))
  const rawRun = () => ({ ...db.prepare('select * from runs').get() })
  const head = () => db.prepare('select head_sequence from run_graph_heads').get().head_sequence
  const publications = [], queries = []
  // Dialect adaptation only; no production query is replaced with a prechosen
  // closed/cleanup answer. In particular EXISTS cleanup predicates run as SQL.
  const query = async (text, values = []) => {
    queries.push(text)
    const sql = text.replaceAll('::text[]', '').replace(/(\$\d+)::(?:text|bigint)/g, '$1')
      .replace(/([\w.]+)=any\((\$\d+)\)/g, '$1 in (select value from json_each($2))')
      .replaceAll('bool_or(', 'max(').replaceAll('count(*)::text', 'cast(count(*) as text) as count')
      .replace(/a\.(last_native_sequence|terminal_native_sequence|projection_revision)::text/g, 'cast(a.$1 as text) as $1')
      .replace('(head_sequence+1)::text', 'cast((head_sequence+1) as text)')
      .replace("n.node->>'id'", "n.value->>'id'")
      .replace("cross join lateral jsonb_array_elements(v.record->'definition'->'nodes') n(node)",
        "cross join json_each(v.record->'definition'->'nodes') n")
      .replaceAll("n.node->>'id'", "n.value->>'id'")
      .replace(/ for update\b/g, '')
    // SQLite compound SELECT output labels come from its first branch, like PG.
    const statement = db.prepare(sql)
    const bindings = Object.fromEntries(values.map((value, i) => [`$${i + 1}`,
      Array.isArray(value) ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value]))
    if (/^\s*select\b/i.test(sql)) {
      const rows = statement.all(bindings).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        ['record', 'activity'].includes(key) && typeof value === 'string' ? JSON.parse(value)
          : ['closed', 'cleanup_pending', 'workflow_closed', 'delivery_blocked', 'blocked', 'cleanup', 'stopped', 'pending', 'work_closed'].includes(key)
            && value !== null ? Boolean(value) : value])))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: Number(statement.run(bindings).changes) }
  }
  const sql = { query }
  const cache = new Map()
  const schema = { parse: (value) => value }
  const substitutes = {
    '@foreman-code/contracts/wave25': { GraphExecutionIdentitySchema: schema, GraphAttentionSchema: schema,
      NativeGraphActivityRecordSchema: schema, WorkflowRunV2Schema: schema, RunGraphScopeSchema: schema,
      canonicalGraphJson: canonical, RUN_GRAPH_LIMITS: { nodes: 1000, exchanges: 2000 } },
    [resolve(modules, 'run-graph/connection.ts')]: { assertGraphTransaction: () => undefined },
    [resolve(modules, 'run-graph/errors.ts')]: { RunGraphError: FixtureError },
    [resolve(modules, 'errors.ts')]: { DomainError: FixtureError },
    [resolve(modules, 'run-graph/records.ts')]: { readNodeResolutions: async () => [] },
    [resolve(modules, 'run-graph/publication.ts')]: { graphSourceDigest: digest },
    [resolve(modules, 'interactions/wave25/context.ts')]: { fail: (code) => { throw new FixtureError(code) } },
    [resolve(modules, 'runs/oneShotPostgres.ts')]: { readOneShotRunState: async (_sql, _id, current, stop) => {
      const { publicAttentionTotals, readPublicAttentionCounts } = load(resolve(modules, 'run-graph/currentAttention.ts'))
      return { executionState: current.executionState, outcome: current.outcome, stopRequested: stop,
        ...publicAttentionTotals(await readPublicAttentionCounts(sql, scope.runId)) }
    } },
  }
  const allowed = new Set(['run-graph/publicProjection.ts', 'run-graph/currentActivity.ts', 'run-graph/nativeActivitySelection.ts',
    'run-graph/publicLifecycle.ts', 'run-graph/currentAttention.ts', 'runs/oneShotLifecycle.ts', 'interactions/wave25/attention.ts']
    .map((path) => resolve(modules, path)))
  function load(path) {
    if (Object.hasOwn(substitutes, path)) return substitutes[path]
    if (cache.has(path)) return cache.get(path).exports
    assert.ok(allowed.has(path), `Unqualified dependency: ${path}`)
    const module = { exports: {} }; cache.set(path, module)
    new Function('require', 'module', 'exports', compile(readFileSync(path, 'utf8'), path))((name) =>
      load(name.startsWith('.') ? resolve(dirname(path), name.replace(/\.js$/, '.ts')) : name), module, module.exports)
    return module.exports
  }
  const projection = load(resolve(modules, 'run-graph/publicProjection.ts'))
  const activity = load(resolve(modules, 'run-graph/currentActivity.ts'))
  const approval = load(resolve(modules, 'interactions/wave25/attention.ts'))
  const lifecycle = load(resolve(modules, 'runs/oneShotLifecycle.ts'))
  const context = { scope, requester: { ...execution, id: execution.executionId } }
  const publication = { sql, scope, source: async (input, mutate) => {
    validateNativeSource(input.evidence, input.facts)
    const value = await mutate(sql)
    publications.push(structuredClone(input))
    return { replayed: false, value }
  } }
  const transaction = async (action) => {
    const length = publications.length
    db.exec('begin')
    try {
      await action()
      if (publications.length > length) db.exec('update run_graph_heads set head_sequence=head_sequence+1')
      db.exec('commit')
    } catch (error) { db.exec('rollback'); publications.length = length; throw error }
  }
  return { db, sql, scope, projection, activity, approval, context, interaction, publications, queries,
    rawNative, rawRun, head,
    snapshot: () => projection.readPublicNodeProjection(sql, scope, ['node']),
    cleanup: (pending) => transaction(() => lifecycle.publishOneShotCleanup(publication, pending)),
    cancel: () => transaction(async () => {
      const next = { ...interaction, status: 'canceled', revision: 8 }
      // This is the exact failing helper inside publishInteraction, not a
      // replacement selector. The preceding 12-case smoke tests that selector.
      const facts = await approval.approvalAttentionFacts(sql, context, { interaction: next })
      await publication.source({ evidence: { sourceKind: 'interaction', sourceId: next.id, sourceRevision: '8' }, facts }, async () => {
        db.prepare("update durable_interactions set status='canceled',record=? where id=?").run(JSON.stringify(next), next.id)
      })
    }),
  }
}
function nodeReplay(before, publications) {
  const nodes = structuredClone(before)
  for (const source of publications) for (const fact of source.facts) {
    const field = { 'node.state': 'state', 'node.activity': 'activity', 'node.attention': 'attention' }[fact.type]
    if (!field) continue
    const node = nodes.find((row) => row.state.workflowNodeId === fact[field].workflowNodeId)
    assert.ok(node, 'Unknown projection identity')
    node[field] = fact[field]
  }
  return nodes
}
const noCurrentWork = (nodes) => {
  assert.equal(nodes[0].state.lifecycle, 'unknown')
  assert.deepEqual(nodes[0].activity, { workflowNodeId: 'node', status: 'none' })
}

test('non-Stop cleanup publishes its entire node delta at the intent head', async () => {
  const f = fixture()
  try {
    const before = await f.snapshot(), raw = f.rawNative(), run = f.rawRun()
    assert.equal(before[0].activity.status, 'unknown')
    await f.cleanup(true)
    const after = await f.snapshot(); noCurrentWork(after)
    assert.deepEqual(nodeReplay(before, f.publications), after)
    assert.equal(f.head(), 1)
    assert.equal(f.publications.length, 1)
    assert.equal(f.publications[0].evidence.sourceKind, 'cleanup')
    assert.ok(f.publications[0].facts.some((fact) => fact.type === 'node.activity'))
    assert.equal(f.publications[0].facts[0].state.stopRequested, false)
    assert.deepEqual(f.rawNative(), raw); assert.deepEqual(f.rawRun(), run)
  } finally { f.db.close() }
})
test('canceled overlay cannot expose the saved active native start during cleanup', async () => {
  const f = fixture()
  try {
    const before = await f.snapshot(), raw = f.rawNative()
    await f.cleanup(true); await f.cancel()
    const after = await f.snapshot(); noCurrentWork(after)
    assert.deepEqual(nodeReplay(before, f.publications), after)
    assert.equal(after[0].attention.pendingInteractionCount, 0)
    assert.equal(f.publications.at(-1).facts[0].state.cleanupPending, true)
    assert.deepEqual(f.rawNative(), raw)
  } finally { f.db.close() }
})
test('native clear/refresh context uses the same pending-cleanup boundary', async () => {
  const f = fixture()
  try {
    assert.equal((await f.activity.readCurrentActivityContext(f.sql, f.scope, 'node')).closed, false)
    await f.cleanup(true)
    assert.equal((await f.activity.readCurrentActivityContext(f.sql, f.scope, 'node')).closed, true)
  } finally { f.db.close() }
})
test('repeated intent does not allocate another source or alter native evidence', async () => {
  const f = fixture()
  try {
    await f.cleanup(true)
    const head = f.head(), raw = f.rawNative(), sources = structuredClone(f.publications)
    await f.cleanup(true); await f.cleanup(true)
    assert.equal(f.head(), head); assert.deepEqual(f.publications, sources); assert.deepEqual(f.rawNative(), raw)
  } finally { f.db.close() }
})
for (const variant of [{ stopped: true }, { executionState: 'interrupted' }, { executionState: 'completed' }]) {
  test(`clearing cleanup preserves the independent Stop/terminal boundary ${JSON.stringify(variant)}`, async () => {
    const f = fixture(variant)
    try {
      const before = await f.snapshot(), raw = f.rawNative(), run = f.rawRun()
      await f.cleanup(true); await f.cleanup(false)
      const after = await f.snapshot(); noCurrentWork(after)
      assert.deepEqual(nodeReplay(before, f.publications), after)
      assert.deepEqual(f.rawNative(), raw); assert.deepEqual(f.rawRun(), run)
    } finally { f.db.close() }
  })
}
test('cleanup without native evidence still cannot fabricate terminal outcome or Worker acknowledgement', async () => {
  const f = fixture({ native: false })
  try {
    await f.cleanup(true); await f.cancel()
    noCurrentWork(await f.snapshot())
    assert.deepEqual(f.rawNative(), [])
    assert.ok(f.publications.every((p) => p.facts.every((fact) => fact.type !== 'worker.resumed')))
    assert.equal(JSON.parse(f.rawRun().record).outcome, 'pending')
  } finally { f.db.close() }
})
test('clearing before settlement cannot rebrand old active work as a cleanup-sourced acknowledgement', async () => {
  const f = fixture()
  try {
    await f.cleanup(true); await f.cancel()
    const before = await f.snapshot(), head = f.head(), raw = f.rawNative()
    await assert.rejects(f.cleanup(false), /actual native-source refinement/)
    assert.equal(f.db.prepare('select pending from run_cleanup_intents').get().pending, 1)
    assert.deepEqual(await f.snapshot(), before); assert.equal(f.head(), head); assert.deepEqual(f.rawNative(), raw)
  } finally { f.db.close() }
})
test('normal acknowledged native work outside cleanup is not globally rewritten', async () => {
  const f = fixture({ status: null })
  try {
    const nodes = await f.snapshot()
    assert.equal(nodes[0].state.lifecycle, 'running')
    assert.equal(nodes[0].activity.status, 'active')
    const facts = f.projection.publicNodeProjectionFacts(nodes)
    validateNativeSource({ sourceKind: 'native_event' }, facts)
    assert.throws(() => validateNativeSource({ sourceKind: 'cleanup' }, facts), /actual native-source refinement/)
  } finally { f.db.close() }
})
test('the unchanged source refinement still rejects invented Worker resumption', () => {
  assert.throws(() => validateNativeSource({ sourceKind: 'interaction' }, [{ type: 'worker.resumed' }]), /actual native-source refinement/)
})
test('missing Run scope still fails rather than returning a default projection', async () => {
  const f = fixture()
  try { await assert.rejects(f.projection.readPublicNodeProjection(f.sql, { ...f.scope, runId: 'other' }, ['node']), { code: 'GRAPH_SCOPE_MISMATCH' }) }
  finally { f.db.close() }
})
