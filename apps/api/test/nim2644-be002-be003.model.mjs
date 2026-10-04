/** Isolated, dependency-light model checks of the ACTUAL TypeScript service
 * and command coordinator (transpiled in memory). Run explicitly with:
 *   node --test apps/api/test/nim2644-be002-be003.model.mjs
 *
 * No sockets or services. SQL execution/locks, live-principal storage, schemas,
 * configuration inheritance and native effects are modeled, NOT PostgreSQL,
 * Zod, authentication or provider acceptance. The companion integration test
 * covers real authenticated routes/SQL. TypeScript is a repo dev dependency;
 * a global installation can be used by the isolated web verification runner.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import process from 'node:process'
import console from 'node:console'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const runtimeRequire = createRequire(import.meta.url)
const directory = path.dirname(fileURLToPath(import.meta.url))
let ts
try { ts = runtimeRequire('typescript') } catch {
  ts = runtimeRequire(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript'))
}
const root = process.env.NIM2644_SOURCE_ROOT ?? path.resolve(directory, '../../..')
const refRoot = process.env.NIM2644_REFERENCE_ROOT // only for an isolated, incomplete source checkout
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)
class DomainError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status } }
class Client {
  constructor(db) { this.db = db; this.tx = undefined }
  release() {}
  async query(sql, a = []) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    this.db.sql.push(q)
    if (q === 'begin') { assert.equal(this.tx, undefined); this.tx = clone(this.db.tables); return { rows: [] } }
    if (q === 'rollback') { this.tx = undefined; return { rows: [] } }
    if (q === 'commit') {
      if (this.db.failAttemptCommit && this.tx?.audits.length > this.db.tables.audits.length
        && this.tx.audits.some((x) => x.action === 'graph.edit_stop_attempt')) throw new Error('modeled write-ahead COMMIT failure')
      if (this.tx) this.db.tables = this.tx
      this.tx = undefined; return { rows: [] }
    }
    if (q.startsWith('select pg_advisory')) return { rows: [] }
    const table = this.tx ?? this.db.tables
    const result = (rows) => ({ rows: clone(rows), rowCount: rows.length })
    if (q.startsWith('insert into management_audit')) {
      const literal = /'(?<outcome>succeeded|failed|uncertain)'/.exec(q)?.groups?.outcome
      const item = { principal_id: a[0], source: a[1], action: a[2], target_key: a[3],
        outcome: literal ?? a[4], details: JSON.parse(a[literal ? 4 : 5]) }
      table.audits.push(item); return result([])
    }
    if (q.includes('from management_audit')) {
      const action = q.includes("action='graph.edit_stop_tracking'") ? 'graph.edit_stop_tracking' : 'graph.edit_stop_attempt'
      const field = action.endsWith('tracking') ? 'stageCommandId' : 'commandId'
      return result(table.audits.filter((x) => x.principal_id === a[0] && x.action === action && x.target_key === a[1] && x.details[field] === a[2]))
    }
    if (q.startsWith('insert into management_command_receipts')) {
      if (a[1] === 'run.stop' && this.db.failReceipt.has(a[2])) throw new Error('modeled receipt INSERT failure before COMMIT')
      const key = JSON.stringify(a.slice(0, 3)); assert.equal(table.receipts[key], undefined)
      table.receipts[key] = { input_hash: a[4], target_key: a[3], result: JSON.parse(a[5]) }
      return result([])
    }
    if (q.includes('from management_command_receipts')) {
      const key = q.includes("operation='run.stop'") ? JSON.stringify([a[0], 'run.stop', a[1]]) : JSON.stringify(a.slice(0, 3))
      return result(table.receipts[key] ? [table.receipts[key]] : [])
    }
    if (q.startsWith('insert into graph_edit_intents')) { table.intents[a[0]] = JSON.parse(a[6]); return { rows: [], rowCount: 1 } }
    if (q.startsWith('update graph_edit_intents')) { assert.ok(table.intents[a[0]]); table.intents[a[0]] = JSON.parse(a[2]); return { rows: [], rowCount: 1 } }
    if (q.includes('from graph_edit_intents')) {
      if (q.startsWith('select id')) return result(Object.values(table.intents).filter((i) => i.ownerPrincipalId === a[0]
        && i.workspaceId === a[1] && i.workflowId === a[2] && !['saved', 'discarded'].includes(i.state)).map((i) => ({ id: i.id })))
      const i = table.intents[a[0]]
      return result(i && i.ownerPrincipalId === a[1] && i.workspaceId === a[2] && i.workflowId === a[3] ? [{ record: i }] : [])
    }
    if (q.includes('from graph_drafts')) return result([{ record: this.db.draft }])
    if (q.startsWith('select revision::text,current_version_id')) return result([this.db.parent])
    if (q.startsWith('select workspace_id,metadata_revision')) return result(this.db.agents[a[0]] ? [this.db.agents[a[0]]] : [])
    if (q.startsWith('select id from workflows where workspace_id')) return result(this.db.references.map((id) => ({ id })))
    if (q.includes('from agent_configuration_versions')) return result(this.db.configuration ? [{ record: this.db.configuration }] : [])
    throw new Error(`Unmodeled SQL: ${q}`)
  }
}
class Pool {
  constructor(options) { this.options = options; this.db = options.db }
  async connect() { return new Client(this.db) }
  async query(...args) { return new Client(this.db).query(...args) }
  async end() {}
}
function modules(db) {
  const cache = new Map()
  const schema = { parse: clone }
  const receiptSchema = { parse(value) {
    assert.ok(value && typeof value.runId === 'string')
    assert.ok(['accepted', 'not_owner', 'already_terminal'].includes(value.status))
    assert.equal(value.processStopped, false)
    return clone(value)
  } }
  const wave = new Proxy({ sameWorkflowValue: (a, b) => canonical(a) === canonical(b),
    GraphEditStopSchema: { shape: { receipt: { unwrap: () => receiptSchema } } } },
  { get: (target, key) => key in target ? target[key] : schema })
  const authorize = (principal, action, scope) => {
    db.permissions.push({ principal: principal.id, action, scope: clone(scope) })
    if (db.denied.some((d) => d.action === action && (!d.workflowId || d.workflowId === scope.workflowId))) {
      throw new DomainError('ACCESS_DENIED', `denied ${action}`, 403)
    }
  }
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative)
    const filename = [path.join(root, relative), refRoot && path.join(refRoot, relative)].find((p) => p && fs.existsSync(p))
    if (!filename) throw new Error(`Missing reviewed dependency ${relative}; run from an integrated checkout`)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
    assert.equal(output.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0)
    const exports = {}; cache.set(relative, exports)
    const requireFrom = (name) => {
      if (name === 'node:crypto') return runtimeRequire(name)
      if (name === 'pg') return { Pool }
      if (name === '@foreman-code/contracts/wave25') return wave
      if (name === '@foreman-code/contracts' || name === '@foreman-code/contracts/management') return new Proxy({}, { get: () => schema })
      if (name.endsWith('/errors.js')) return { DomainError }
      if (name.endsWith('/access/policy.js')) return { requireAuthorization: authorize, isAuthorized: (p, a, s) => {
        try { authorize(p, a, s); return true } catch { return false }
      } }
      if (name.endsWith('/access/liveManagementPrincipal.js')) return { readLiveManagementPrincipal: async () => clone(db.principal) }
      if (name.endsWith('/commands/postgres.js')) return load('apps/api/src/modules/commands/postgres.ts')
      if (name === './editIntent.js') return load('apps/api/src/modules/graph-drafts/editIntent.ts')
      if (name.endsWith('/workspaces/admission.js')) return { lockActiveWorkspace: async () => undefined }
      if (name === './saveAdmission.js') return { readAffectedGraphRuns: async () => clone(db.current) }
      if (name === './operatorOperations.js') return { assertSourceAgentPins: async () => {
        db.sourcePinChecks++
        if (db.denySourcePin) throw new DomainError('ACCESS_DENIED', 'source reuse scope denied', 403)
      } }
      if (name.endsWith('/workspaces/agentConfiguration.js')) return {
        lockAgentConfigurations: async () => undefined,
        configurationInput: (workspaceId, agent, current) => {
          db.merges.push({ workspaceId, agent: clone(agent), current: clone(current) })
          return { harness: agent.harnessConfiguration ?? current?.harness,
            assignedSkills: agent.assignedSkills ?? current?.assignedSkills ?? [] }
        },
      }
      // The authorization-only GraphDraftService path must not invoke any
      // other dependency. Make accidental extra behavior fail loudly.
      return new Proxy({}, { get: (_, key) => {
        if (key === '__esModule') return false
        return () => { throw new Error(`Unmodeled dependency ${name}.${String(key)}`) }
      } })
    }
    vm.runInNewContext(`(function(require,module,exports){${output.outputText}\n})`, { console, Date, Error, Set, Map, JSON },
      { filename })(requireFrom, { exports }, exports)
    return exports
  }
  return { load }
}
async function setup({ runs = 1, staged = true, skills = false, dangerous = false, inherited = false } = {}) {
  const agent = { id: 'agent-1', configurationVersionId: 'config-1', name: 'staged Agent' }
  const config = { id: 'config-1', agentId: agent.id,
    harness: { harness: 'codex', sandbox: dangerous ? 'danger-full-access' : 'workspace-write', model: 'synthetic' },
    assignedSkills: skills ? [{ skillId: 's', version: '1' }] : [] }
  if (!inherited) { agent.harnessConfiguration = config.harness; agent.assignedSkills = config.assignedSkills }
  const db = { tables: { audits: [], receipts: {}, intents: {} },
    principal: { id: 'owner' }, denied: [], permissions: [], sql: [], sourcePinChecks: 0, denySourcePin: false, merges: [],
    parent: { revision: '1', current_version_id: 'wf-v1', archived_at: null },
    agents: { 'agent-1': { workspace_id: 'workspace', metadata_revision: '1', current_configuration_version_id: 'config-1', archived_at: null } },
    configuration: config, references: ['workflow', 'sibling'], failReceipt: new Set(), failAttemptCommit: false,
    calls: [], effects: 0, published: 0, stopCompletes: false,
    current: Array.from({ length: runs }, (_, i) => ({ pin: { workspaceId: 'workspace', workflowId: i ? 'sibling' : 'workflow',
      runId: `run-${i}`, workflowVersionId: 'wf-v1', agentConfigurationVersionIds: { 'agent-1': 'config-1' } }, settled: false })),
    draft: { id: 'draft', workspaceId: 'workspace', workflowId: 'workflow', revision: 1, baseWorkflowVersionId: 'wf-v1',
      graph: { nodes: [{ id: 'node-1', agentId: 'agent-1' }] }, stagedAgents: [] },
  }
  const pool = new Pool({ db })
  const { load } = modules(db)
  const { PostgresCommandCoordinator, commandInputHash } = load('apps/api/src/modules/commands/postgres.ts')
  const { GraphDraftService } = load('apps/api/src/modules/graph-drafts/service.ts')
  const { GraphEditIntentService } = load('apps/api/src/modules/graph-drafts/editIntent.ts')
  const commands = new PostgresCommandCoordinator(pool)
  const authorization = new GraphDraftService(pool, commands)
  const prepared = { draft: { ...clone(db.draft), stagedAgents: staged ? [{ agent, baseRevision: 1 }] : [] },
    savedWorkflowRevision: 1, agentPins: [{ agentId: 'agent-1', metadataRevision: 1, configurationVersionId: 'config-1' }] }
  let service
  const boundary = {
    prepare: async () => clone(prepared),
    authorizePublication: (client, p, draft) => authorization.authorizeEditPublication(client, p, draft),
    publish: async (principal, source, input, intentId) => {
      await service.transaction(principal, async (client, live) => {
        await service.publication(client, live, intentId, input)
        await service.saved(client, live, intentId, { draft: db.draft, version: { id: 'wf-v2' }, agents: [] })
      })
      db.published++
    },
  }
  const rebuild = () => { service = new GraphEditIntentService(pool, new PostgresCommandCoordinator(pool), boundary); return service }
  rebuild()
  const stageInput = { action: 'stage_edits', workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft',
    expectedRevision: 1, expectedWorkflowVersionId: 'wf-v1', executionSemanticsVersion: 2, commandId: 'stage-command', operations: [] }
  const intent = (await service.stage(db.principal, 'http', stageInput)).intent
  const command = { action: 'stop_and_save', workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft',
    intentId: intent.id, commandId: intent.advanceCommandId }
  const stop = async (principal, source, input) => {
    const stored = db.tables.audits.find((a) => a.action === 'graph.edit_stop_attempt' && a.details.commandId === input.commandId)
    if (db.requireAttemptBeforeStop) {
      assert.ok(stored, 'attempt must be committed before the first Stop dispatch')
      assert.equal(stored.details.inputHash, commandInputHash(input))
    }
    db.calls.push(clone(input))
    const result = await commands.execute({ principal, source, operation: 'run.stop', commandId: input.commandId,
      dedicatedConnection: true, targetKey: `run:${input.runId}`, payload: input,
      perform: async () => {
        const run = db.current.find((r) => r.pin.runId === input.runId)
        const wasSettled = run.settled
        if (!wasSettled) db.effects++
        if (db.stopCompletes) run.settled = true
        return { runId: input.runId, status: wasSettled ? 'already_terminal' : 'accepted', processStopped: false }
      },
    })
    if (db.lostReply) throw new Error('modeled reply lost AFTER receipt COMMIT')
    return { ...result.value, replayed: result.replayed }
  }
  return { db, pool, commands, authorization, intent, command, stop, rebuild, hash: commandInputHash,
    service: () => service, advance: () => service.advance(db.principal, 'http', command, stop),
    receiptKey: (entry) => JSON.stringify(['owner', 'run.stop', entry.input.commandId]),
    currentIntent: () => db.tables.intents[intent.id],
  }
}

for (const action of ['graph:edit', 'graph:read']) {
  test(`BE-002 secondary ${action} revoked with Stop grants intact: neither Stop dispatched`, async () => {
    const t = await setup({ runs: 2 }); t.db.denied.push({ action, workflowId: 'sibling' })
    await assert.rejects(t.advance(), { code: 'ACCESS_DENIED' })
    assert.equal(t.db.calls.length, 0); assert.equal(t.db.effects, 0); assert.equal(t.db.published, 0)
    assert.deepEqual(t.currentIntent().stops, t.intent.stops)
    t.db.denied = []
    const retry = await t.advance()
    assert.equal(retry.intent.state, 'waiting')
    assert.deepEqual(t.db.calls, t.intent.stops.map((s) => s.input))
    assert.ok(retry.intent.stops.every((s) => s.receipt))
  })
}
for (const inherited of [false, true]) {
  for (const [flag, action] of [['skills', 'skills:read'], ['dangerous', 'harnesses:update']]) {
    test(`BE-002 ${inherited ? 'inherited' : 'explicit'} ${action} revoked before Stop`, async () => {
      const t = await setup({ inherited, [flag]: true }); t.db.denied.push({ action })
      await assert.rejects(t.advance(), { code: 'ACCESS_DENIED' })
      assert.equal(t.db.calls.length, 0); assert.equal(t.db.published, 0)
      if (inherited) assert.ok(t.db.merges.length > 0)
    })
  }
}
test('BE-002 source reuse authorization is rechecked before any Stop', async () => {
  const t = await setup(); t.db.denySourcePin = true
  await assert.rejects(t.advance(), { code: 'ACCESS_DENIED' }); assert.equal(t.db.calls.length, 0)
})
test('BE-002 revocation between first and second Stop blocks the second without rolling back the first receipt', async () => {
  const t = await setup({ runs: 2 })
  const result = await t.service().advance(t.db.principal, 'http', t.command, async (...a) => {
    const reply = await t.stop(...a); t.db.denied.push({ action: 'graph:edit', workflowId: 'sibling' }); return reply
  }).catch((e) => e)
  assert.equal(result.code, 'ACCESS_DENIED'); assert.equal(t.db.calls.length, 1)
  assert.ok(t.currentIntent().stops[0].receipt); assert.equal(t.currentIntent().stops[1].receipt, undefined)
  assert.equal(t.db.published, 0)
})
test('BE-003 Stage protocol marker is durable in the Stage transaction', async () => {
  const t = await setup()
  assert.deepEqual(t.db.tables.audits.filter((a) => a.action === 'graph.edit_stop_tracking').map((a) => a.details), [{ stageCommandId: 'stage-command' }])
  assert.equal(t.db.calls.length, 0)
})
test('BE-003 the first Stop observes its write-ahead evidence already committed', async () => {
  const t = await setup(); t.db.requireAttemptBeforeStop = true
  const r = await t.advance(); assert.equal(r.intent.state, 'waiting'); assert.equal(t.db.calls.length, 1)
})
test('BE-003 failure of write-ahead COMMIT prevents Stop invocation', async () => {
  const t = await setup(); t.db.failAttemptCommit = true
  const r = await t.advance()
  assert.equal(r.intent.state, 'uncertain'); assert.equal(t.db.calls.length, 0)
  assert.equal(t.db.tables.audits.filter((a) => a.action === 'graph.edit_stop_attempt').length, 0)
})
test('BE-003 actual coordinator receipt INSERT failure after effect cannot become natural completion', async () => {
  const t = await setup(); const entry = t.intent.stops[0]
  t.db.stopCompletes = true; t.db.failReceipt.add(entry.input.commandId)
  let r = await t.advance()
  assert.equal(r.intent.state, 'uncertain'); assert.equal(t.db.effects, 1); assert.ok(t.db.current[0].settled)
  assert.equal(t.db.tables.receipts[t.receiptKey(entry)], undefined)
  assert.equal(t.currentIntent().stops[0].receipt, undefined); assert.equal(t.db.published, 0)
  assert.ok(t.db.tables.audits.some((a) => a.action === 'run.stop' && a.outcome === 'failed'))
  t.rebuild()
  r = await t.advance() // still missing receipt, even though the Run is settled
  assert.equal(r.intent.state, 'uncertain'); assert.equal(t.db.published, 0)
  assert.deepEqual(t.db.calls, [entry.input, entry.input])
  assert.equal(t.db.effects, 1) // already-terminal reconciliation does not cancel again
  t.db.failReceipt.clear()
  r = await t.advance()
  assert.equal(r.intent.state, 'saved'); assert.equal(t.db.published, 1)
  assert.deepEqual(t.db.calls, [entry.input, entry.input, entry.input])
  assert.deepEqual(r.intent.stops[0].receipt, { runId: entry.input.runId, status: 'already_terminal', processStopped: false })
  assert.equal((await t.advance()).intent.state, 'saved'); assert.equal(t.db.calls.length, 3)
})
test('BE-003 settled but attempted Stop still requires Stop permission', async () => {
  const t = await setup(); t.db.stopCompletes = true; t.db.failReceipt.add(t.intent.stops[0].input.commandId)
  await t.advance(); t.db.failReceipt.clear(); t.db.denied.push({ action: 'runs:stop' })
  await assert.rejects(t.advance(), { code: 'ACCESS_DENIED' })
  assert.equal(t.db.calls.length, 1); assert.equal(t.db.published, 0)
})
test('BE-003 an unreceipted callback return is not authoritative acknowledgement', async () => {
  const t = await setup()
  const result = await t.service().advance(t.db.principal, 'http', t.command, async (_p, _s, input) => {
    t.db.current[0].settled = true
    return { runId: input.runId, status: 'accepted', processStopped: false }
  })
  assert.equal(result.intent.state, 'uncertain'); assert.equal(result.intent.stops[0].receipt, undefined); assert.equal(t.db.published, 0)
})
test('BE-003 a reply lost AFTER committed receipt is reconciled without resubmission', async () => {
  const t = await setup(); t.db.lostReply = true
  let r = await t.advance(); assert.equal(r.intent.state, 'waiting'); assert.ok(r.intent.stops[0].receipt)
  t.db.current[0].settled = true; t.rebuild(); r = await t.advance()
  assert.equal(r.intent.state, 'saved'); assert.equal(t.db.calls.length, 1)
})
test('BE-003 natural completion before submission retains no Stop receipt', async () => {
  const t = await setup(); t.db.current[0].settled = true
  const r = await t.advance()
  assert.equal(r.intent.state, 'saved'); assert.equal(t.db.calls.length, 0); assert.equal(r.intent.stops[0].receipt, undefined)
  assert.equal(t.db.tables.audits.filter((a) => a.action === 'graph.edit_stop_attempt').length, 0)
})
test('BE-003 multiple Runs distinguish a prior attempt from a naturally completed sibling', async () => {
  const t = await setup({ runs: 2 }); const entry = t.intent.stops[0]
  t.db.stopCompletes = true; t.db.failReceipt.add(entry.input.commandId)
  await t.advance(); t.db.current[1].settled = true; t.db.failReceipt.clear(); t.rebuild()
  const r = await t.advance()
  assert.equal(r.intent.state, 'saved'); assert.ok(r.intent.stops[0].receipt); assert.equal(r.intent.stops[1].receipt, undefined)
  assert.deepEqual(t.db.calls, [entry.input, entry.input])
})
for (const field of ['input_hash', 'target_key', 'result']) {
  test(`BE-003 contradictory durable receipt ${field} blocks instead of being overwritten`, async () => {
    const t = await setup(); await t.advance(); t.db.current[0].settled = true
    const row = t.db.tables.receipts[t.receiptKey(t.intent.stops[0])]
    row[field] = field === 'result' ? { runId: 'wrong-run', status: 'accepted', processStopped: false } : 'wrong'
    const before = clone(row), r = await t.advance()
    assert.equal(r.intent.state, 'blocked'); assert.equal(r.intent.error.code, 'COMMAND_ID_CONFLICT')
    assert.deepEqual(t.db.tables.receipts[t.receiptKey(t.intent.stops[0])], before)
    assert.equal(t.db.calls.length, 1); assert.equal(t.db.published, 0)
  })
}
test('BE-003 durable receipt disappearing after journal observation retains uncertainty', async () => {
  const t = await setup(); await t.advance(); delete t.db.tables.receipts[t.receiptKey(t.intent.stops[0])]
  t.db.current[0].settled = true
  assert.equal((await t.advance()).intent.state, 'uncertain'); assert.equal(t.db.calls.length, 1); assert.equal(t.db.published, 0)
})
test('BE-003 attempt evidence hash conflict blocks before dispatch', async () => {
  const t = await setup(); t.db.failReceipt.add(t.intent.stops[0].input.commandId); await t.advance()
  t.db.tables.audits.find((a) => a.action === 'graph.edit_stop_attempt').details.inputHash = 'wrong'
  const r = await t.advance(); assert.equal(r.intent.state, 'blocked'); assert.equal(r.intent.error.code, 'COMMAND_ID_CONFLICT')
  assert.equal(t.db.calls.length, 1)
})
test('BE-003 advanced untracked legacy intent remains uncertain, never silently natural', async () => {
  const t = await setup(); t.db.tables.audits = []; t.currentIntent().state = 'uncertain'; t.db.current[0].settled = true
  const r = await t.advance(); assert.equal(r.intent.state, 'uncertain'); assert.equal(t.db.calls.length, 0); assert.equal(t.db.published, 0)
})
test('BE-003 untouched legacy Stage can safely establish tracking before advance', async () => {
  const t = await setup(); t.db.tables.audits = []; t.db.current[0].settled = true
  const r = await t.advance(); assert.equal(r.intent.state, 'saved'); assert.equal(t.db.calls.length, 0)
  assert.ok(t.db.tables.audits.some((a) => a.action === 'graph.edit_stop_tracking'))
})
test('BE-003 saveAttempted cannot bypass an unreconciled Stop attempt', async () => {
  const t = await setup(); t.db.stopCompletes = true; t.db.failReceipt.add(t.intent.stops[0].input.commandId); await t.advance()
  t.currentIntent().saveAttempted = true
  const r = await t.advance(); assert.equal(r.intent.state, 'uncertain'); assert.equal(t.db.published, 0)
})
test('BE-003 final publication independently rejects unreceipted attempts', async () => {
  const t = await setup(); t.db.stopCompletes = true; t.db.failReceipt.add(t.intent.stops[0].input.commandId); await t.advance()
  t.currentIntent().state = 'saving'; t.currentIntent().saveAttempted = true
  await assert.rejects(t.service().transaction(t.db.principal, (client, live) =>
    t.service().publication(client, live, t.intent.id, t.intent.saveInput)), /Reconcile the exact Stop receipt/)
  assert.equal(t.db.published, 0)
})
