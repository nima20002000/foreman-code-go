/* global Buffer, URL */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

// No production logic substitutions. Transform TypeScript syntax and resolve
// the one extensionless runtime import to an identical transformed module.
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const loadSource = (name) => readFile(new URL(name, import.meta.url), 'utf8')
const errors = moduleUrl(stripTypeScriptTypes(await loadSource('errors.ts'), { mode: 'transform' }))
const source = stripTypeScriptTypes(await loadSource('legacyCurrent.ts'), { mode: 'transform' })
const { keepLatestRunCurrent } = await import(moduleUrl(source.replace(/(['"])\.\/errors\1/, JSON.stringify(errors))))
const value = (sequence = '10') => ({
  kind: 'legacy-run-current', executionSemanticsVersion: 1,
  run: { id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
    executionState: 'running', outcome: 'pending', createdAt: '2026-09-22T00:00:00.000Z' },
  executions: [], executionCoverage: 'latest-attempt-per-pinned-node', cleanupPending: false,
  settlement: 'unconfirmed', history: 'not-included', asOfActivitySequence: sequence,
})
const completed = (record, outcome = 'succeeded') => ({ ...record,
  run: { ...record.run, executionState: 'completed', outcome, finishedAt: '2026-09-22T01:00:00.000Z' } })

test('accepts the first compact response without manufacturing history', () => {
  const current = value()
  assert.equal(keepLatestRunCurrent(undefined, current), current)
  assert.equal('activity' in current, false)
})
test('rejects a lower high-water observation before promoting a terminal outcome', () => {
  const current = value('9007199254740993')
  assert.equal(keepLatestRunCurrent(current, completed(value('9007199254740992'))), current)
})
test('accepts cleanup changes with an equal high-water observation', () => {
  const current = completed({ ...value(), cleanupPending: true })
  const next = { ...current, cleanupPending: false }
  assert.equal(keepLatestRunCurrent(current, next), next)
  assert.equal(next.settlement, 'unconfirmed')
})
test('keeps completed lifecycle and outcome sticky', () => {
  const current = completed(value())
  for (const next of [value('11'), completed(value('11'), 'failed'), completed(value('11'), 'canceled')]) {
    assert.equal(keepLatestRunCurrent(current, next), current)
  }
})
test('does not turn interruption into resumed work from a read', () => {
  const current = { ...value(), run: { ...value().run, executionState: 'interrupted' } }
  for (const executionState of ['queued', 'running', 'waiting']) {
    assert.equal(keepLatestRunCurrent(current, { ...value('11'), run: { ...value().run, executionState } }), current)
  }
})
test('retains an existing persisted Stop field if a response omits it', () => {
  // The guard treats this validated field as opaque; schema validation is in
  // the separate contract suite, not simulated by this dependency-free test.
  const current = { ...value(), run: { ...value().run, stopCause: { opaquePersistedEvidence: true } } }
  assert.equal(keepLatestRunCurrent(current, value('11')), current)
})
test('rejects every immutable identity change', () => {
  for (const key of ['id', 'workspaceId', 'workflowId', 'workflowVersionId']) {
    assert.throws(() => keepLatestRunCurrent(value(), { ...value('11'), run: { ...value().run, [key]: 'other' } }), /GRAPH_SCOPE_MISMATCH/)
  }
})
test('does not confuse a larger history observation with active work or settlement', () => {
  const current = completed(value())
  const next = { ...current, asOfActivitySequence: '100000' }
  assert.equal(keepLatestRunCurrent(current, next), next)
  assert.equal(next.run.outcome, 'succeeded')
  assert.equal(next.settlement, 'unconfirmed')
})

test('default legacy client request uses only the current shared schema/route', async () => {
  const client = await loadSource('client.ts')
  assert.match(client, /legacy: \(scope, signal\) => client\.request\(legacyCurrentReadPath\(scope\), RunCurrentResponseSchema, \{ signal \}\)/)
  assert.doesNotMatch(client, /client\.getRun\(/)
  assert.match(client, /export async function readLegacyRunActivityPage/)
  const sync = await loadSource('sync.ts')
  assert.doesNotMatch(sync, /readLegacyRunActivityPage|\/events\?limit|GetRunResponseSchema/)
  assert.match(sync, /RunCurrentResponseSchema\.safeParse\(await api\.legacy/)
})
test('compatibility polling remains conservative and does not infer settlement from cleanup', async () => {
  const sync = await loadSource('sync.ts')
  const policy = sync.slice(sync.indexOf("if (result.facts?.reader === 'legacy')"), sync.indexOf('// Only after fetchQuery'))
  assert.match(policy, /return ACTIVE_POLL_MS/)
  assert.doesNotMatch(policy, /return false/)
  assert.match(sync, /cached\?\.facts\?\.reader === 'legacy' && !RunCurrentResponseSchema\.safeParse/)
})
test('current SQL has indexed limits rather than lifetime aggregation, count or native joins', async () => {
  const content = await readFile(new URL('../../../../api/src/modules/runs/liveSnapshot.ts', import.meta.url), 'utf8')
  const current = content.slice(content.indexOf('export async function readRunCurrent('))
  assert.match(current, /from run_activity a\s+where a.run_id=r.id order by a.sequence desc limit 1/)
  assert.match(current, /where e.run_id=r.id and e.workflow_node_id=node.value->>'id'\s+order by e.attempt desc limit 1/)
  assert.doesNotMatch(current, /count\s*\(|harness_native_events|review_jobs|projectRunLiveActivity|a\.payload|offset\s/i)
  assert.match(current, /where r.workspace_id=\$1 and r.workflow_id=\$2 and r.id=\$3 and r.workflow_version_id=\$4/)
})
test('view labels latest-attempt coverage and unknown settlement instead of complete history', async () => {
  const view = await loadSource('RunGraphView.tsx')
  assert.match(view, /Latest execution attempt per saved node/)
  assert.match(view, /Approval and native settlement remain unconfirmed/)
  assert.doesNotMatch(view, /response\.activity/)
})
