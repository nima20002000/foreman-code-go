import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!(); vi.restoreAllMocks() })
async function fixture() {
  const f = await checkpointRuntimeFixture(); closes.push(f.close)
  await f.engine.start(f.f.run.id)
  const [interaction] = await f.pending()
  if (!interaction) throw new Error('Expected captured native wait')
  return { ...f, interaction }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native I/O blocked the Run publication lock')), 5000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

describe.skipIf(!postgresEnabled)('BR1-005/006: current PostgreSQL cleanup and delivery boundaries', () => {
  it('stops a delivered approval without native acknowledgement through authenticated MCP', async () => {
    const f = await currentOperatorIntegration()
    closes.push(f.close)
    await f.engine.start(f.f.run.id)
    const interaction = (await f.pending())[0]!
    const resume = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValueOnce(
      new DomainError('ENGINE_RESTART', 'The approval callback was interrupted.', 409))
    try {
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction))
    } finally {
      resume.mockRestore()
    }
    expect((await f.repository.get(interaction.id))?.deliveryState).toBe('delivered')
    expect(await f.receipts()).toEqual([])
    const reader = await f.access.issue({ name: 'Run reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['runs:read'], scope: { runIds: [f.f.run.id] } }] })
    const monitor = await f.connect(reader.token)
    const input = { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id, commandId: randomUUID() }
    const denied = await monitor.callTool({ name: 'run_stop', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await f.runs.hasRequestedStop(input.runId)).toBe(false)
    const stopped = await f.client.callTool({ name: 'run_stop', arguments: input })
    expect(stopped.isError).not.toBe(true)
    expect(decodeMcpToolResult(stopped)).toMatchObject({ status: 'accepted', processStopped: false })
    await vi.waitFor(async () => {
      expect((await f.runs.get(input.runId))?.outcome).toBe('canceled')
      expect(await f.runs.hasPendingCleanup(input.runId)).toBe(false)
    }, { timeout: 60000, interval: 50 })
    const record = await monitor.callTool({ name: 'run_record_get', arguments: {
      workspaceId: input.workspaceId, runId: input.runId,
    } })
    expect(record.isError).not.toBe(true)
    expect(RunRecordDetailSchema.parse(decodeMcpToolResult(record))).toMatchObject({
      run: { executionState: 'completed', outcome: 'canceled' }, stopRequested: true, cleanupPending: false,
    })
    const replay = await f.client.callTool({ name: 'run_stop', arguments: input })
    expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true })
    expect(f.provider.counts.responses).toBe(1)
    expect(await f.receipts()).toEqual([])
  }, 90000)

  it('cleanup without user Stop fences authority and actual cancellation settles the Run as failed', async () => {
    const f = await fixture()
    const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try { await f.runs.requestCleanup(f.f.run.id, owner) } finally { await owner.release() }
    await expect(f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))).rejects.toBeDefined()
    await f.engine.cancel(f.f.run.id)
    expect((await f.repository.get(f.interaction.id))?.status).toBe('canceled')
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('failed')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.starts).toBe(2)
  }, 60000)

  it('unconfirmed provider closure retains cleanup without manufacturing closure or Stop', async () => {
    const f = await fixture()
    f.provider.beforeClose = async () => { throw new Error('Native closure unconfirmed') }
    const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try { await f.runs.requestCleanup(f.f.run.id, owner) } finally { await owner.release() }
    try {
      await expect(f.engine.cancel(f.f.run.id)).rejects.toBeDefined()
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(true)
      expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
      expect(await f.receipts()).toEqual([])
      expect(f.provider.closedSessions.has(f.interaction.nativeSessionId)).toBe(false)
    } finally { delete f.provider.beforeClose; await f.engine.cancel(f.f.run.id) }
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(false)
    expect(f.provider.counts.starts).toBe(2)
  }, 60000)

  it('Stop commits independently while the actual provider response remains unresolved', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await within(entered.promise)
      await within(f.stop())
      expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(true)
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      const row = (await f.db.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rows[0]
      expect(row?.state).not.toBe('resumed')
    } finally { release.resolve(); await observed; await f.engine.cancel(f.f.run.id) }
  }, 60000)

  it('a changed native generation cannot consume the old provider response', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then(() => undefined, (error: unknown) => error)
    try {
      await within(entered.promise)
      await f.db.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}','1'::jsonb) where native_session_id=$1", [f.interaction.nativeSessionId])
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      expect((await f.runs.get(f.f.run.id))?.outcome).not.toBe('succeeded')
      expect(f.provider.counts.responses).toBe(1)
    } finally { release.resolve(); await observed }
  }, 60000)

  it('clears a current Run cleanup intent with no native or review work', async () => {
    const db = await agent3Database(); closes.push(db.close)
    const f = await currentRepositoryFixture(db)
    const owner = await f.repository.acquireOwnership(f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try {
      await f.repository.requestCleanup(f.f.run.id, owner)
      await f.repository.settleOrphan(f.f.run.id, owner, false)
      await f.repository.finishCleanup(f.f.run.id, false, owner)
      expect(await f.repository.hasPendingCleanup(f.f.run.id)).toBe(false)
      expect(await f.repository.hasRequestedStop(f.f.run.id)).toBe(false)
      expect(await f.repository.listRepeatExecutions(f.f.run.id)).toEqual([])
    } finally { await owner.release() }
  }, 60000)
})
