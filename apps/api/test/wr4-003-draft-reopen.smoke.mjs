/* global process, URL, structuredClone */
/** Dependency-free caller-seam checks for the actual GraphDraftService.open body.
 * Run: node --test apps/api/test/wr4-003-draft-reopen.smoke.mjs
 * Optional WR4_003_SERVICE_SOURCE selects an unmodified baseline for a red check.
 * SQL, schemas, authorization and workflow locking are synthetic ports here.
 * These checks are NOT PostgreSQL trigger, isolation, schema or transport proof;
 * the companion opt-in .integration.test.ts supplies those real boundaries. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const path = process.env.WR4_003_SERVICE_SOURCE ?? fileURLToPath(new URL('../src/modules/graph-drafts/service.ts', import.meta.url))
const source = readFileSync(path, 'utf8')
const match = / {2}async open\(principal: ManagementPrincipal, workspaceId: string, workflowId: string\): Promise<GraphDraft> \{([\s\S]*?)\n {2}\}\n\n {2}async get\(/.exec(source)
assert.ok(match, 'Expected the actual open method signature and following get boundary')
// Remove the one TypeScript-only query type argument, not executable statements.
const body = match[1].replaceAll('query<DraftRow>', 'query')
const compile = new Function('requireAuthorization', 'GraphDraftSchema', 'WorkflowDefinitionSchema', 'randomUUID', 'draftSemantics',
  `return async function open(principal, workspaceId, workflowId) {${body}\n}`)
const copy = (value) => structuredClone(value)

function fixture({ typedSource = false, existing = 'discarded', unversioned = false, fault } = {}) {
  const graph = { id: 'workflow', workspaceId: 'workspace', name: 'Accepted source',
    nodes: [{ id: 'entry', agentId: 'reviewer', name: 'Entry' }, { id: 'worker', agentId: 'worker-agent', name: 'Worker' }],
    edges: [{ id: 'execution', source: 'entry', target: 'worker', ...(typedSource ? { kind: 'execution' } : {}) }],
    approval: typedSource ? { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' } : { handler: 'user' },
    ...(typedSource ? { executionSemanticsVersion: 2, entryNodeId: 'entry' } : {}),
  }
  if (typedSource) graph.edges.push({ id: 'accepted-approval', kind: 'approval', source: 'entry', target: 'worker' })
  const workflow = { record: graph, current_version_id: unversioned ? null : 'accepted-version' }
  const dirty = { id: 'discarded-id', workspaceId: 'workspace', workflowId: 'workflow', revision: 7,
    baseWorkflowVersionId: workflow.current_version_id, publishedRevision: typedSource ? 3 : 0,
    graph: { ...copy(graph), executionSemanticsVersion: 2, entryNodeId: 'entry', name: 'Discarded edit',
      edges: [{ id: 'execution', kind: 'execution', source: 'entry', target: 'worker' }] },
    stagedAgents: [{ agent: { id: 'discarded-agent' }, baseRevision: null }],
    sourceAgentPins: [{ agentId: 'discarded-agent', metadataRevision: 1, configurationVersionId: 'discarded-config' }],
    updatedByPrincipalId: 'previous-principal', updatedAt: '2026-09-23T00:00:00.000Z' }
  const old = { id: dirty.id, workspace_id: 'workspace', workflow_id: 'workflow', record: dirty,
    revision: 7, base_workflow_version_id: workflow.current_version_id, discarded_at: existing === 'active' ? null : 'discarded-at' }
  const sibling = { ...copy(old), id: 'sibling-draft', workspace_id: 'other-workspace', workflow_id: 'other-workflow' }
  const state = { rows: existing === 'none' ? [sibling] : [old, sibling], workflow, calls: [], connections: 0, releases: 0,
    receipt: { target_key: 'draft:discarded-id', result: { discarded: true, draftId: 'discarded-id', revision: 7 } },
    fault, marker: undefined }
  let tx, locked = false, advisory = false, selected = false, ids = 0
  const client = {
    async query(raw, values = []) {
      const sql = raw.replace(/\s+/g, ' ').trim()
      state.calls.push({ sql, values: copy(values) })
      if (sql === 'begin') { assert.equal(tx, undefined); tx = copy(state.rows); return { rows: [] } }
      if (sql === 'commit') {
        assert.ok(tx); state.rows = tx; tx = undefined; state.marker = undefined
        locked = false; advisory = false; selected = false
        return { rows: [] }
      }
      if (sql === 'rollback') {
        tx = undefined; state.marker = undefined; locked = false; advisory = false; selected = false
        return { rows: [] }
      }
      assert.ok(tx, 'All open SQL must be in its transaction')
      if (sql === 'select pg_advisory_xact_lock(hashtext($1))') {
        assert.ok(locked); assert.deepEqual(values, ['draft:workflow']); advisory = true; return { rows: [] }
      }
      if (sql === 'select id, record, discarded_at from graph_drafts where workspace_id = $1 and workflow_id = $2 for update') {
        assert.ok(locked && advisory); assert.deepEqual(values, ['workspace', 'workflow']); selected = true
        return { rows: copy(tx.filter((row) => row.workspace_id === values[0] && row.workflow_id === values[1])) }
      }
      assert.ok(locked && advisory && selected, 'Writes retain workflow/advisory/row ordering')
      if (sql === 'delete from graph_drafts where id = $1 and workspace_id = $2 and workflow_id = $3 and discarded_at is not null') {
        assert.deepEqual(values, ['discarded-id', 'workspace', 'workflow'])
        const previous = tx.length
        tx = tx.filter((row) => !(row.id === values[0] && row.workspace_id === values[1] && row.workflow_id === values[2] && row.discarded_at !== null))
        return { rows: [], rowCount: previous - tx.length }
      }
      if (sql === "select set_config('graphql.approval_writer','v2',true)") {
        state.marker = 'v2'; return { rows: [] }
      }
      if (sql === 'insert into graph_drafts (id, workspace_id, workflow_id, revision, base_workflow_version_id, record) values ($1, $2, $3, 0, $4, $5::jsonb)') {
        assert.equal(tx.some((row) => row.id === 'discarded-id'), false, 'Old instance removed before insertion')
        assert.equal(tx.some((row) => row.workflow_id === values[2]), false, 'No duplicate current workflow draft')
        const record = JSON.parse(values[4])
        assert.deepEqual(record.graph, state.workflow.record, 'Insert only the accepted saved source')
        assert.equal(record.baseWorkflowVersionId, state.workflow.current_version_id)
        if (record.graph.executionSemanticsVersion === 2) assert.equal(state.marker, 'v2')
        if (state.fault === 'insert') throw new Error('INJECTED_INSERT_FAILURE')
        tx.push({ id: values[0], workspace_id: values[1], workflow_id: values[2], revision: 0,
          base_workflow_version_id: values[3], record, discarded_at: null })
        return { rows: [], rowCount: 1 }
      }
      // In particular, the old UPDATE reset is NOT emulated as a successful
      // insert and this fake does not pretend to implement PostgreSQL triggers.
      throw new Error(`Unexpected SQL at lifecycle seam: ${sql}`)
    },
    release() { state.releases++ },
  }
  const open = compile(
    (principal, action, scope) => {
      assert.equal(action, 'graph:read'); assert.deepEqual(scope, { workspaceId: 'workspace', workflowId: 'workflow' })
      if (principal.denied) throw new Error('ACCESS_DENIED')
    },
    { parse(value) { if (state.fault === 'draft-schema') throw new Error('DRAFT_SCHEMA_REJECTED'); return copy(value) } },
    { parse(value) { if (state.fault === 'source-schema') throw new Error('SOURCE_SCHEMA_REJECTED'); return copy(value) } },
    () => `fresh-${++ids}`, (draft) => draft.graph.executionSemanticsVersion === 2 ? 2 : 1,
  )
  const service = {
    pool: { async connect() { state.connections++; return client } },
    async lockActiveWorkflow(received, workspaceId, workflowId) {
      assert.equal(received, client); assert.deepEqual([workspaceId, workflowId], ['workspace', 'workflow']); assert.ok(tx)
      state.calls.push({ sql: 'WORKFLOW_LOCK', values: [workspaceId, workflowId] })
      if (state.fault === 'workflow-lock') throw new Error('WORKFLOW_UNAVAILABLE')
      locked = true; return copy(state.workflow)
    },
    readableDraft(_principal, draft) { if (state.fault === 'read') throw new Error('AGENTS_READ_DENIED'); return copy(draft) },
  }
  return { state, dirty: copy(dirty), sibling: copy(sibling), open: (principal = { id: 'caller' }) => open.call(service, principal, 'workspace', 'workflow') }
}

for (const typedSource of [false, true]) {
  const variant = typedSource ? 'B: accepted v2 approval source' : 'A: unpublished converted legacy source'
  test(`${variant} replaces only the discarded instance`, async () => {
    const f = fixture({ typedSource }), beforeWorkflow = copy(f.state.workflow), receipt = copy(f.state.receipt)
    const fresh = await f.open()
    assert.notEqual(fresh.id, f.dirty.id)
    assert.equal(fresh.revision, 0)
    assert.equal(fresh.publishedRevision, 0)
    assert.equal(fresh.baseWorkflowVersionId, beforeWorkflow.current_version_id)
    assert.deepEqual(fresh.graph, beforeWorkflow.record)
    assert.deepEqual(fresh.stagedAgents, [])
    assert.equal(fresh.sourceAgentPins, undefined)
    assert.equal(fresh.updatedByPrincipalId, 'caller')
    assert.deepEqual(f.state.rows.find((row) => row.id === fresh.id).record, fresh)
    assert.deepEqual(f.state.rows.find((row) => row.id === 'sibling-draft'), f.sibling)
    assert.equal(f.state.rows.some((row) => row.id === f.dirty.id), false)
    assert.deepEqual(f.state.workflow, beforeWorkflow); assert.deepEqual(f.state.receipt, receipt)
    assert.equal(f.state.releases, 1); assert.equal(f.state.calls.at(-1).sql, 'commit')
  })
  test(`${variant} insertion failure rolls back the synthetic deletion`, async () => {
    const f = fixture({ typedSource, fault: 'insert' }), before = copy(f.state.rows)
    await assert.rejects(f.open(), /INJECTED_INSERT_FAILURE/)
    assert.ok(f.state.calls.some((call) => call.sql.startsWith('delete from')))
    assert.deepEqual(f.state.rows, before)
    assert.equal(f.state.calls.at(-1).sql, 'rollback')
    assert.equal(f.state.marker, undefined); assert.equal(f.state.releases, 1)
    f.state.fault = undefined
    const retry = await f.open()
    assert.notEqual(retry.id, f.dirty.id)
    assert.deepEqual(retry.graph, f.state.workflow.record)
  })
  test(`${variant} first open inserts without deleting and qualifies typed source only`, async () => {
    const f = fixture({ typedSource, existing: 'none' })
    const fresh = await f.open()
    assert.equal(f.state.calls.some((call) => call.sql.startsWith('delete from')), false)
    assert.equal(f.state.calls.filter((call) => call.sql.includes('set_config')).length, typedSource ? 1 : 0)
    assert.equal(f.state.marker, undefined, 'Transaction-local marker does not escape COMMIT')
    assert.deepEqual(fresh.graph, f.state.workflow.record)
  })
}

test('active draft is returned rather than reset from accepted source', async () => {
  const f = fixture({ typedSource: true, existing: 'active' })
  assert.deepEqual(await f.open(), f.dirty)
  assert.equal(f.state.calls.some((call) => /^(delete|insert|update)|set_config/.test(call.sql)), false)
})
test('repeated open returns the same fresh instance without a second write', async () => {
  const f = fixture({ typedSource: true })
  const first = await f.open(), second = await f.open()
  assert.deepEqual(second, first)
  assert.equal(f.state.calls.filter((call) => call.sql.startsWith('insert into')).length, 1)
  assert.equal(f.state.calls.filter((call) => call.sql.startsWith('delete from')).length, 1)
  assert.equal(f.state.releases, 2)
})
test('unversioned source retains null base and publication markers', async () => {
  const f = fixture({ unversioned: true })
  const fresh = await f.open()
  assert.equal(fresh.baseWorkflowVersionId, null); assert.equal(fresh.publishedRevision, null)
})
test('read authorization failure happens before connection or SQL', async () => {
  const f = fixture()
  await assert.rejects(f.open({ id: 'denied', denied: true }), /ACCESS_DENIED/)
  assert.equal(f.state.connections, 0); assert.deepEqual(f.state.calls, [])
})
for (const [fault, message] of [['workflow-lock', /WORKFLOW_UNAVAILABLE/], ['source-schema', /SOURCE_SCHEMA_REJECTED/], ['draft-schema', /DRAFT_SCHEMA_REJECTED/]]) {
  test(`${fault} failure precedes deletion and releases the transaction`, async () => {
    const f = fixture({ fault }), before = copy(f.state.rows)
    await assert.rejects(f.open(), message)
    assert.equal(f.state.calls.some((call) => call.sql.startsWith('delete from')), false)
    assert.deepEqual(f.state.rows, before)
    assert.equal(f.state.calls.at(-1).sql, 'rollback'); assert.equal(f.state.releases, 1)
  })
}
test('active draft read failure does not delete or recreate it', async () => {
  const f = fixture({ existing: 'active', fault: 'read' }), before = copy(f.state.rows)
  await assert.rejects(f.open(), /AGENTS_READ_DENIED/)
  assert.deepEqual(f.state.rows, before)
  assert.equal(f.state.calls.some((call) => /^(delete|insert|update)/.test(call.sql)), false)
  assert.equal(f.state.calls.at(-1).sql, 'rollback'); assert.equal(f.state.releases, 1)
})
