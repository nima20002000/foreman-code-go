import { assertOwnedExecutionDestinations, assertOwnedTestApi,
  ownedTestDatabaseUrl, ownedTestPath } from './helpers/testResources.js'
/** EXPLICIT OPT-IN, real running loopback product + same task-owned PostgreSQL.
 * No provider mocks, seed conversion, direct accepted-result/native/closure writes
 * or custom CurrentRunProductionBinding. Run from apps/api with pinned tsx.
 * See the handoff QUALIFICATION.md for the input manifest and limits. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import {
  CurrentWorkflowReadResultSchema, RunStartV3InputSchema, RunStartV3ResultSchema,
  RepeatGraphSnapshotV3Schema, RepeatGraphPageV3Schema, reduceRepeatGraphPageV3,
  canonicalGraphJson, type RepeatGraphSnapshotV3,
} from '@foreman-code/contracts/wave25'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { readAcceptedRepeatRunLocked } from '../src/modules/runs/repeatStartRead.js'
import { assertWorkflowRunSettlementLocked } from '../src/modules/runs/workflowRepositoryServices.js'
import { assertRepeatCanonicalReceiptLocked } from '../src/modules/run-graph/repeatReceipts.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import type { WorkflowNativeProofRecord } from '../src/modules/runs/workflowNativeProof.js'

type Case = { id: string; mode: 'complete' | 'stop-native' | 'stop-approval'; start: unknown;
  expectedProvider: 'codex'; expectedRepeat: boolean;
  expectedExit?: 'early_exit' | 'limit_exit'; existingRunId?: string; minimumGenerations?: number; stopCommandId?: string }
function required(name: string): string { const value = process.env[name]; assert.ok(value, `${name} is required`); return value }
assert.equal(process.env.RUN_ENG04_A2_REAL_PROVIDERS, '1', 'This program requires explicit real-provider opt-in')
const origin = new URL(required('A2_QUALIFICATION_ORIGIN')), connection = new URL(ownedTestDatabaseUrl('WAVE25_TEST_DATABASE_URL'))
const local = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
assert.ok(local(origin) && origin.protocol === 'http:' && !origin.username && !origin.password, 'Use only the task-owned loopback app')
assert.ok(local(connection) && connection.pathname.toLowerCase().includes('test'), 'Use only an explicitly named loopback test database')
const schema = required('A2_QUALIFICATION_SCHEMA'); assert.match(schema, /^a2q_[a-z0-9_]+$/)
const candidate = required('A2_CANDIDATE_SHA'); assert.match(candidate, /^[0-9a-f]{40}$/)
const token = required('A2_QUALIFICATION_TOKEN'), path = process.argv[2]
assert.ok(path, 'Pass the prepared current saved-workflow case manifest as the only argument')
const cases: Case[] = JSON.parse(await readFile(path, 'utf8'))
assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 20)
assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
const output = ownedTestPath(required('A2_QUALIFICATION_REPORT'))
const pool = new pg.Pool({ connectionString: connection.toString(), max: 4,
  options: `-c search_path=${schema} -c lock_timeout=5000 -c statement_timeout=10000` })
const evidence: Record<string, unknown>[] = []
const deadlineMs = 300000
async function http(method: string, route: string, body?: unknown) {
  const response = await fetch(new URL(route, origin), { method, signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const json: unknown = await response.json()
  return { status: response.status, body: json }
}
async function rpc(name: string, args: unknown): Promise<{ failed: boolean; value: unknown }> {
  const response = await fetch(new URL('/mcp', origin), { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) })
  const text = await response.text()
  const envelope = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n') : text)
  assert.ok(response.ok && !envelope.error, `MCP transport failed (${response.status})`)
  const result = envelope.result
  const value = result.structuredContent ?? JSON.parse(result.content.find((item: { type: string }) => item.type === 'text').text)
  return { failed: result.isError === true, value }
}
async function waitFor(predicate: () => Promise<boolean>, label: string) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) { if (await predicate()) return; await delay(250) }
  // Elapsed time is only a FAILURE bound, never negative submission or closure.
  throw new Error(`${label}: timed out with original identity retained; no settlement is inferred`)
}
try {
  await assertOwnedTestApi(origin, pool)
  assert.equal((await pool.query('select version from application_migrations where version=264602')).rowCount, 1)
  for (const item of cases) {
    assert.ok(['complete', 'stop-native', 'stop-approval'].includes(item.mode))
    const input = RunStartV3InputSchema.parse(item.start)
    await assertOwnedExecutionDestinations(pool, { workspaceId: input.workspaceId,
      agentConfigurationVersionIds: Object.values(input.expectedAgentConfigurationVersionIds),
      ...(item.existingRunId ? { runId: item.existingRunId } : {}) })
    const wfPath = `/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}`
    const savedResponse = await http('GET', `${wfPath}/definition`)
    assert.equal(savedResponse.status, 200)
    const saved = CurrentWorkflowReadResultSchema.parse(savedResponse.body)
    assert.equal(saved.currentVersionId, input.workflowVersionId); assert.equal(saved.revision, input.expectedWorkflowRevision)
    assert.deepEqual(saved.version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
    assert.equal(Object.hasOwn(saved.version.definition, 'repeat'), item.expectedRepeat)
    const first = item.existingRunId ? await rpc('run_start', input) : { failed: false, value: (await http('POST', `${wfPath}/runs`, input)).body }
    assert.equal(first.failed, false)
    const started = RunStartV3ResultSchema.parse(first.value), runId = started.run.id
    assert.equal(started.replayed, item.existingRunId !== undefined)
    if (item.existingRunId) assert.equal(runId, item.existingRunId)
    const query = new URLSearchParams({ workflowVersionId: input.workflowVersionId, executionSemanticsVersion: '3' })
    const graphPath = `/api/workspaces/${encodeURIComponent(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}/runs/${encodeURIComponent(runId)}/graph/v1`
    const readSnapshot = async () => {
      const response = await http('GET', `${graphPath}/snapshot?${query}`); assert.equal(response.status, 200)
      return RepeatGraphSnapshotV3Schema.parse(response.body)
    }
    const initial = await readSnapshot()
    assert.equal(initial.historyCoverage, 'from_admission')
    const replay = await rpc('run_start', input); assert.equal(replay.failed, false)
    const exact = RunStartV3ResultSchema.parse(replay.value)
    assert.equal(exact.replayed, true); assert.deepEqual(exact.run, started.run)
    const conflict = await rpc('run_start', { ...input, input: { a2Conflict: randomUUID() } })
    assert.equal(conflict.failed, true)
    if (item.mode !== 'complete') assert.ok(item.stopCommandId, 'Persist the original Stop command ID in the manifest before running')
    const stopInput = { workspaceId: input.workspaceId, runId, commandId: item.stopCommandId ?? 'not-submitted' }
    if (item.mode !== 'complete') {
      await waitFor(async () => {
        // Select when to send Stop, NOT proof that the native turn has settled.
        const sql = item.mode === 'stop-approval'
          ? `select 1 from durable_interactions where run_id=$1 and approval_native_request_proof_id is not null and status='pending'`
          : `select 1 from workflow_native_entries where run_id=$1 and phase='entered'`
        return (await pool.query(sql, [runId])).rowCount! > 0
      }, `${item.id} entered its selected Stop window`)
      await waitFor(async () => {
        const result = await rpc('run_stop', stopInput)
        if (result.failed) return false // Same exact command, never a new ID.
        const receipt = result.value as { runId: string; processStopped: boolean; status: string }
        assert.equal(receipt.runId, runId); assert.equal(receipt.processStopped, false)
        assert.ok(['accepted', 'already_terminal'].includes(receipt.status))
        return true
      }, `${item.id} exact Stop command`)
      const repeat = await rpc('run_stop', stopInput); assert.equal(repeat.failed, false)
      assert.equal((repeat.value as { replayed: boolean }).replayed, true)
    }
    await waitFor(async () => {
      const rows = await pool.query<{ ready: boolean }>(`select execution_state='completed'
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as ready from runs r where id=$1`, [runId])
      return rows.rows[0]?.ready === true // Merely selects when to validate REAL proof below.
    }, `${item.id} durable settlement`)
    const owner = await RunOwnership.acquire(pool, runId, () => undefined); assert.ok(owner, 'Original runtime owner has not released')
    let executions: HarnessExecution[] = []
    const proofIds: string[] = []
    try {
      await owner.oneShotConnection().transaction(async (sql) => {
        const accepted = await readAcceptedRepeatRunLocked(sql, runId)
        assert.equal(accepted.run.workflowVersionId, input.workflowVersionId)
        assert.deepEqual(accepted.run.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
        assert.deepEqual(accepted.run.input, input.input)
        assert.equal(accepted.run.executionLocation.locationRevision, input.expectedLocationRevision)
        assert.equal(accepted.cleanupPending, false)
        if (item.mode === 'complete') assert.equal(accepted.run.outcome, 'succeeded')
        else assert.equal(accepted.stopRequested, true)
        await assertWorkflowRunSettlementLocked(sql, accepted.run, owner, item.mode === 'complete' ? 'success' : 'cleanup')
        const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: input.workflowVersionId, runId, executionSemanticsVersion: 3 as const }
        const rows = await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>('select record,source_digest from workflow_native_proofs where run_id=$1 order by proof_id', [runId])
        assert.ok(rows.rows.length > 0, 'No original native-source publication exists')
        const providers = new Set<string>(), generations = new Map<string, Set<string>>()
        for (const row of rows.rows) {
          const record = row.record
          assert.equal(graphSourceDigest(record), row.source_digest)
          assert.deepEqual(record.scope, scope); providers.add(record.session.harness)
          const key = `${record.execution.executionId}:${record.session.nativeSessionId}`
          const seen = generations.get(key) ?? new Set<string>(); seen.add(String(record.closureGeneration)); generations.set(key, seen)
          await assertRepeatCanonicalReceiptLocked(sql, { scope, evidence: { sourceKind: 'native_event', sourceId: record.proofId, sourceRevision: '1' }, sourceDigest: row.source_digest, effect: null })
          proofIds.push(record.proofId)
        }
        assert.ok(providers.has(item.expectedProvider))
        if (item.minimumGenerations) {
          assert.ok(Number.isSafeInteger(item.minimumGenerations) && item.minimumGenerations >= 2)
          assert.ok([...generations.values()].some((seen) => seen.size >= item.minimumGenerations!), 'No required same-execution/session generation transition')
        }
        const rowsE = await sql.query<{ record: unknown }>('select record from harness_executions where run_id=$1 order by id', [runId])
        executions = rowsE.rows.map((row) => HarnessExecutionSchema.parse(row.record))
        assert.ok(executions.length > 0)
        const ordinaryIds = new Set((await sql.query<{ execution_id: string }>('select execution_id from workflow_native_entries where run_id=$1', [runId])).rows.map((r) => r.execution_id))
        if (item.mode === 'complete') for (const execution of executions.filter((e) => ordinaryIds.has(e.id))) {
          const histories = rows.rows.map((row) => row.record).filter((r) => r.execution.executionId === execution.id && r.original.type === 'history')
          assert.ok(histories.some((r) => {
            if (r.original.type !== 'history') return false
            try { assertOriginalWorkflowTerminal(execution, r.session, r.original.history); return true } catch { return false }
          }), 'A completed execution has no original native terminal source')
        }
        const occurrences = await sql.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [runId])
        const decisions = await sql.query<{ reason: string }>("select record->>'reason' as reason from run_repeat_decisions where run_id=$1", [runId])
        if (!item.expectedRepeat) { assert.equal(occurrences.rowCount, 0); assert.equal(decisions.rowCount, 0) }
        else { assert.ok(occurrences.rowCount! > 0); if (item.expectedExit) assert.ok(decisions.rows.some((r) => r.reason === item.expectedExit)) }
      })
    } finally { await owner.release() }
    let projected: RepeatGraphSnapshotV3 = initial
    for (let pageNumber = 0; ; pageNumber++) {
      assert.ok(pageNumber < 1000, 'Canonical page bound exceeded')
      const response = await http('GET', `${graphPath}/events?${query}&afterSequence=${projected.asOfSequence}`); assert.equal(response.status, 200)
      const page = RepeatGraphPageV3Schema.parse(response.body) // Reset/gap is NOT a pass.
      projected = reduceRepeatGraphPageV3(projected, page)
      if (!page.hasMore) break
    }
    const final = await readSnapshot()
    assert.equal(canonicalGraphJson(projected), canonicalGraphJson(final), 'Complete-delta/snapshot parity failed')
    const entryCount = (await pool.query('select execution_id,phase from workflow_native_entries where run_id=$1 order by execution_id', [runId])).rows
    const finalReplay = await rpc('run_start', input); assert.equal(finalReplay.failed, false)
    assert.equal(RunStartV3ResultSchema.parse(finalReplay.value).replayed, true)
    assert.deepEqual((await pool.query('select execution_id,phase from workflow_native_entries where run_id=$1 order by execution_id', [runId])).rows, entryCount)
    evidence.push({ caseId: item.id, mode: item.mode, candidate, runId, workflowVersionId: input.workflowVersionId,
      asOfSequence: final.asOfSequence, executionIds: executions.map((e) => e.id), nativeSessionIds: executions.map((e) => e.nativeSessionId), proofIds,
      startCommandId: input.commandId, ...(item.mode === 'complete' ? {} : { stopCommandId: stopInput.commandId }) })
    console.log(JSON.stringify({ caseId: item.id, runId, result: 'passed-requested-live-case' }))
  }
  await writeFile(output, JSON.stringify({ status: 'requested-cases-passed', candidate, evidence,
    notClaimed: ['Cases not in this manifest', 'Board interaction', 'Unperformed owner-loss/restart faults', 'Whole ENG-04 phase gate'] }, null, 2))
} catch (error) {
  await writeFile(output, JSON.stringify({ status: 'failed', candidate, evidence,
    failure: error instanceof Error ? error.name : 'qualification failed', note: 'Retain original command identities; no Stop/cleanup is inferred.' }, null, 2))
  throw new Error('A2 live qualification failed; retained report and original manifest commands must be reconciled. No native success is claimed.', { cause: error })
} finally { await pool.end() }
