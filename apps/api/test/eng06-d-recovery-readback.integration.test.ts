import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunRecordDetailSchema, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  executionRows, readback, readParity, recoveryFixture, runPath, scope, toolValue, assertRecoveryReceipts,
  type Form, type RecoveryFixture, type Transport,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['sequential', 'repeat']
async function parked(f: RecoveryFixture) {
  await expect.poll(async () => {
    const rows = await executionRows(f)
    return { run: (await f.runtime.runs.getRepeatSnapshot(f.base.f.run.id)).run.executionState,
      states: rows.map((row) => row.execution.state), submissions: f.provider.counts.starts,
      parked: rows.every((row) => f.provider.atBarrier(row.execution.id)) }
  }, { timeout: 20000 }).toEqual({ run: 'running', states: ['running'], submissions: 1, parked: true })
  const before = await readback(f)
  expect(before.record.run).not.toHaveProperty('result')
  expect(before.details).toHaveLength(1)
  expect(before.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
  expect(before.details[0]).not.toHaveProperty('reportedResult')
  return before
}
function errorCode(result: unknown) {
  const message = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  expect(message.isError).toBe(true)
  const text = message.content?.find((item) => item.type === 'text')?.text
  expect(text).toBeDefined()
  return (JSON.parse(text!) as { error: { code: string } }).error.code
}
async function denyRead(f: RecoveryFixture, client: Transport['client'], token: string,
  name: 'run_record_get' | 'run_execution_get', executionId?: string) {
  const input = { ...scope(f), ...(executionId ? { executionId } : {}) }
  const response = await f.transport.app.inject({ method: 'GET',
    url: `${runPath(f)}${executionId ? `/executions/${executionId}` : '/record'}`,
    headers: { authorization: `Bearer ${token}` } })
  expect(response.statusCode, response.body).toBe(403)
  expect(response.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect(errorCode(await client.callTool({ name, arguments: input }))).toBe('ACCESS_DENIED')
}
afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: terminal state, exact results, inputs and version pins survive two API rebuilds without native work', async (form) => {
    const f = await recoveryFixture(form)
    try {
      f.launch(); await f.settled()
      const before = await readback(f)
      expect(before.record.run.outcome).toBe('succeeded')
      expect(before.record.run.result).toBeDefined()
      const version = RunVersionDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.version, scope(f)))
      const counts = { ...f.provider.counts }
      for (let restart = 0; restart < 2; restart++) {
        const oldApp = f.transport.app, oldRuns = f.runtime.runs, oldEngine = f.runtime.engine, oldSaver = f.runtime.checkpointer
        await f.restart()
        expect(f.transport.app).not.toBe(oldApp)
        expect(f.runtime.runs).not.toBe(oldRuns); expect(f.runtime.engine).not.toBe(oldEngine)
        expect(f.runtime.checkpointer).not.toBe(oldSaver)
        expect(await readback(f)).toEqual(before)
        expect(await readParity(f, RUN_INSPECTION_TOOLS.version, scope(f))).toEqual(version)
        expect(f.provider.counts.starts).toBe(counts.starts)
        expect(f.provider.counts.sessions).toBe(counts.sessions)
        expect(f.provider.counts.attaches).toBe(counts.attaches)
      }
      if (form === 'sequential') {
        expect(version.version.definition).not.toHaveProperty('repeat')
        for (const item of before.page.items) expect(item).not.toHaveProperty('occurrence')
      } else expect(new Set(before.page.items.map((item) => item.occurrence!.occurrenceIndex))).toEqual(new Set([1, 2, 3]))
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: provider-only history behind a lost reply is not an accepted result after restart', async (form) => {
    const f = await recoveryFixture(form, () => 'durable_reply_gap')
    try {
      f.launch(); const before = await parked(f), original = before.details[0]!.execution.executionId
      // This is provider durability, NOT an application result/acceptance COMMIT.
      // d32a361 deliberately does not cold-attach to fetch that provider history.
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      await f.restart()
      const during = await readback(f), counts = { ...f.provider.counts }
      // Restart durably fences reentry before original transport detachment.
      // It changes no model result, accepted input, task, session or Run fact;
      // recovery/settlement below, not provider history, clears this obligation.
      expect(during).toEqual({ ...before, record: { ...before.record, cleanupPending: true },
        page: { ...before.page, run: { ...before.page.run, cleanupPending: true } },
        details: before.details.map((detail) => ({ ...detail, run: { ...detail.run, cleanupPending: true } })) })
      expect((await f.base.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.base.f.run.id])).rows).toEqual([{ pending: true }])
      expect(f.provider.recoveryCalls).toEqual([])
      await f.settled()
      const after = await readback(f), recovered = after.details[0]!
      expect(after.record).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
        result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } },
      cleanupPending: false, stopRequested: false })
      expect(after.details).toHaveLength(1)
      expect(recovered.execution).toMatchObject({ executionId: original, attempt: 1, state: 'completed' })
      expect(recovered.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(recovered.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(recovered.acceptedInput).toEqual(before.details[0]!.acceptedInput)
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      expect(f.provider.counts.starts).toBe(counts.starts)
      expect(f.provider.counts.sessions).toBe(counts.sessions)
      expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [original])
      expect(after.record.run.agentConfigurationVersionIds).toEqual(before.record.run.agentConfigurationVersionIds)
      expect(after.record.run.executionLocation).toEqual(before.record.run.executionLocation)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: an already accepted predecessor result survives cold cleanup of its unfinished successor', async (form) => {
    const f = await recoveryFixture(form, (submission) => submission.request.workflowNodeId.endsWith('-1') ? 'park' : 'success')
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).filter((row) => f.provider.atBarrier(row.execution.id)).length,
        { timeout: 20000 }).toBe(1)
      const before = await readback(f), accepted = before.details.find((item) => item.acceptedResult.status === 'accepted')!
      const waiting = before.details.find((item) => item.execution.state === 'running')!
      expect(before.details).toHaveLength(2)
      expect(accepted).toBeDefined(); expect(waiting).toBeDefined()
      expect(accepted.acceptedResult).toMatchObject({ status: 'accepted', value: accepted.reportedResult })
      await f.restart(); await f.settled()
      const after = await readback(f), retained = after.details.find((item) => item.execution.executionId === accepted.execution.executionId)!
      expect(after.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed',
        result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } })
      expect(after.details).toHaveLength(2)
      expect(retained.execution).toEqual(accepted.execution)
      expect(retained.acceptedInput).toEqual(accepted.acceptedInput)
      expect(retained.reportedResult).toEqual(accepted.reportedResult)
      expect(retained.acceptedResult).toEqual(accepted.acceptedResult)
      const interrupted = after.details.find((item) => item.execution.executionId === waiting.execution.executionId)!
      expect(interrupted.reportedResult).toMatchObject({ outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(interrupted.acceptedInput).toEqual(waiting.acceptedInput)
      expect(interrupted.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(f.provider.counts.starts).toBe(2); expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [waiting.execution.executionId])
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: a dead native owner without a durable terminal cannot leave the Run running forever', async (form) => {
    let first = true
    const f = await recoveryFixture(form, () => { if (first) { first = false; return 'park' } return 'success' })
    try {
      f.launch(); const before = await parked(f), original = before.details[0]!.execution.executionId
      await f.restart(); await f.settled()
      const after = await readback(f), rows = await executionRows(f), abandoned = rows.find((row) => row.execution.id === original)!
      expect(after.record.cleanupPending).toBe(false)
      expect(after.record.run.executionState).toBe('completed')
      expect(abandoned.execution.state).toBe('completed')
      expect(abandoned.execution.result).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(after.record.run).toMatchObject({ outcome: 'failed', result: { outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } })
      expect(abandoned.result_json).toBeNull()
      // Conservative interruption is not an original retryable native failure.
      // Neither a technical attempt nor a business occurrence is manufactured.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.execution.attempt).toBe(1)
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [original])
      expect(after.record.run.input).toEqual(before.record.run.input)
      expect(after.record.run.workflowVersionId).toBe(before.record.run.workflowVersionId)
      // Completed recovery remains stable under further reconciliation/readback.
      const submissions = f.provider.counts.starts
      await f.runtime.engine.reconcile((error) => f.errors.push(error))
      expect(await readback(f)).toEqual(after)
      expect(f.provider.counts.starts).toBe(submissions)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: missing physical closure evidence stays uncertain until an exact receipt becomes available', async (form) => {
    const f = await recoveryFixture(form, () => 'park')
    try {
      f.launch(); const before = await parked(f), id = before.details[0]!.execution.executionId
      await f.restart()
      f.provider.recoveryProofAvailable = false
      await expect(f.runtime.engine.start(f.base.f.run.id)).rejects.toThrow()
      const pending = await readback(f)
      expect(pending.record).toMatchObject({ run: { executionState: 'running', outcome: 'pending' }, cleanupPending: true })
      expect(pending.record.run).not.toHaveProperty('result')
      expect(pending.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect((await f.base.db.pool.query('select generation from execution_native_recoveries where execution_id=$1', [id])).rows).toEqual([])
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
      f.provider.recoveryProofAvailable = true
      await f.settled()
      const settled = await readback(f)
      expect(settled.record).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
        result: { error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } }, cleanupPending: false })
      await assertRecoveryReceipts(f, [id])
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  describe.each(forms)('%s Stop during restart recovery', (form) => {
    it.each(['http', 'mcp'] as const)('%s accepts the exact Stop and settles cleanup rather than returning 409 forever', async (via) => {
      const f = await recoveryFixture(form, () => 'park')
      try {
        f.launch(); const before = await parked(f)
        await f.restart()
        const input = { ...scope(f), commandId: randomUUID() }
        const send = async () => {
          if (via === 'mcp') return toolValue(await f.transport.client.callTool({ name: 'run_stop', arguments: input }), f.diagnostics()) as {
            runId: string; status: string; replayed: boolean; processStopped: boolean }
          const response = await f.transport.app.inject({ method: 'POST', url: `${runPath(f)}/stop`,
            headers: { authorization: `Bearer ${f.base.writer.token}` }, payload: input })
          // Deliberately NOT 409/REPEAT_CLEANUP_PENDING, not it.fails, not a mock.
          expect(response.statusCode, JSON.stringify({ body: response.body, diagnostics: f.diagnostics() })).toBe(200)
          return response.json<{ runId: string; status: string; replayed: boolean; processStopped: boolean }>()
        }
        const receipt = await send()
        expect(receipt.runId).toBe(f.base.f.run.id)
        expect(['accepted', 'already_terminal']).toContain(receipt.status)
        expect(receipt.replayed).toBe(false)
        await f.settled()
        const after = await readback(f), replayed = await send()
        expect(after.record).toMatchObject({ run: { executionState: 'completed' },
          stopRequested: true, cleanupPending: false })
        expect(after.record.run.outcome).toBe('canceled')
        expect(replayed).toEqual({ ...receipt, replayed: true })
        expect(after.record.run.input).toEqual(before.record.run.input)
        expect(after.record.run.workflowVersionId).toBe(before.record.run.workflowVersionId)
        expect(after.details).toHaveLength(1)
        expect(after.details[0]!.execution.executionId).toBe(before.details[0]!.execution.executionId)
        expect(after.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
        expect(after.details[0]!.reportedResult).toEqual({ outcome: 'canceled' })
        expect(f.provider.counts.attaches).toBe(0)
        await assertRecoveryReceipts(f, [before.details[0]!.execution.executionId])
        expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.sessions).toBe(1)
        expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.base.f.scope.workflowId])).rows).toHaveLength(1)
        expect(f.shutdownErrors).toEqual([])
      } finally { await f.close() }
    }, 90000)
  })

  it.each(forms)('%s: rebuilt HTTP/MCP reads retain live grants, redaction, denied-scope audits and read-only behavior', async (form) => {
    const f = await recoveryFixture(form)
    try {
      f.launch(); await f.settled(); await f.restart()
      const expected = await readback(f), executionId = expected.details[0]!.execution.executionId
      const allowed = await f.base.access.issue({ name: 'ENG06 restarted runs-only reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { runIds: [f.base.f.run.id] } }] })
      const client = await f.transport.connect(allowed.token), counts = { ...f.provider.counts }
      const record = RunRecordDetailSchema.parse(await readParity(f, RUN_INSPECTION_TOOLS.record, scope(f), client, allowed.token))
      const redacted = structuredClone(expected.record); delete redacted.run.executionLocation
      expect(record).toEqual(redacted); expect(record.run).not.toHaveProperty('authorizationPrincipalId')
      const detail = await readParity(f, RUN_INSPECTION_TOOLS.execution, { ...scope(f), executionId }, client, allowed.token)
      expect(detail).toEqual(expected.details[0])
      const tools = (await client.listTools()).tools
      expect(tools.find((tool) => tool.name === RUN_INSPECTION_TOOLS.record)?.annotations?.readOnlyHint).toBe(true)
      expect(tools.map((tool) => tool.name)).not.toContain('run_start')
      expect(tools.map((tool) => tool.name)).not.toContain('run_stop')
      const wrongScope = await f.base.access.issue({ name: 'ENG06 wrong Run reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }] })
      const denied = await f.transport.connect(wrongScope.token)
      await denyRead(f, denied, wrongScope.token, RUN_INSPECTION_TOOLS.record)
      await denyRead(f, denied, wrongScope.token, RUN_INSPECTION_TOOLS.execution, executionId)
      const audits = (await f.base.db.pool.query<{ source: string }>('select source from management_audit where principal_id=$1',
        [wrongScope.principal.id])).rows
      expect(audits.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      expect((await f.transport.app.inject({ method: 'GET', url: `${runPath(f)}/record`, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      expect((await f.transport.app.inject({ method: 'GET', url: `${runPath(f)}/executions/${executionId}`, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      expect(f.provider.counts).toEqual(counts)
      expect(await readback(f)).toEqual(expected)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
