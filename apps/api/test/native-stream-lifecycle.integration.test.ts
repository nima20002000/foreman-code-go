import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { deferred, postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  try { while (closes.length) await closes.pop()!() } finally { vi.restoreAllMocks() }
})

async function assertOperatorReadback(f: Awaited<ReturnType<typeof checkpointRuntimeFixture>>) {
  const access = new PostgresAccessService(f.db.pool)
  const reader = await access.issue({ name: 'Streaming Run reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'],
      scope: { workspaceIds: [f.f.scope.workspaceId] } }] })
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const services = {
    commands,
    runs: new RunManagementService(f.db.pool, commands, f.runs, f.engine, f.locations),
  } as OperatorServices
  const app = buildApp({ readiness: { database: { ping: async () => { await f.db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  try {
    const read = await graphRpc(app, reader.token, 'tools/call', { name: 'run_get',
      arguments: { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id } })
    expect(read.status).toBe(200)
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ run: { id: f.f.run.id,
      executionSemanticsVersion: 3, outcome: 'succeeded' } })
    const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'run_start', arguments: {
      workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, workflowVersionId: f.f.version.id,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: 1,
      expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
      expectedLocationRevision: f.f.run.executionLocation!.locationRevision, input: {},
    } })
    expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  } finally { await app.close() }
}

// Only the external transport is deterministic; capture, PostgreSQL and graph writers are real.
describe.skipIf(!postgresEnabled)('native stream lifecycle', () => {
  it('rolls back every frame when a batch contains bytes that differ from its original capture', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
    closes.push(f.close)
    const original = f.provider.startTurn.bind(f.provider)
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      for await (const event of original(session, input)) {
        yield event
        if (event.type !== 'turn.started') continue
        for (let index = 0; index < 4; index++) {
          yield { ...event, sequence: index + 10, type: 'native.notification', payload: { text: `original-${index}` } }
        }
      }
    })
    const append = f.runs.appendNativeEvents.bind(f.runs)
    let rejectedExecutionId: string | undefined
    vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (frames, ...args) => {
      if (frames.length > 1 && !rejectedExecutionId) {
        rejectedExecutionId = frames[0]!.event.executionId
        const changed = frames.map((frame, index) => index === frames.length - 1
          ? { ...frame, event: { ...frame.event, payload: { text: 'changed source' } } } : frame)
        return append(changed, ...args)
      }
      return append(frames, ...args)
    })
    await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'NATIVE_SOURCE_NOT_CAPTURED' })
    expect(rejectedExecutionId).toBeTruthy()
    const raw = await f.db.pool.query(
      `select 1 from harness_native_events where execution_id=$1 and record->>'type'='native.notification'`,
      [rejectedExecutionId])
    expect(raw.rowCount).toBe(0)
    const proofs = await f.db.pool.query(
      `select 1 from workflow_native_proofs where execution_id=$1
       and record#>>'{original,event,type}'='native.notification'`, [rejectedExecutionId])
    expect(proofs.rowCount).toBe(0)
  }, 60_000)

  it('releases a silent stream after publication failure and recovers without another native submission', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
    closes.push(f.close)
    const reading = deferred()
    const release = deferred()
    const detached = deferred()
    const original = f.provider.startTurn.bind(f.provider)
    let failedSessionId: string | undefined
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      try {
        for await (const event of original(session, input)) {
          yield event
          const execution = await f.runs.getExecution(session.nativeSessionId.slice('native-'.length))
          if (event.type !== 'turn.started' || execution?.workflowNodeId === f.f.version.entryNodeId) continue
          failedSessionId = session.nativeSessionId
          yield { ...event, sequence: 10, type: 'native.notification', payload: { text: 'partial' } }
          reading.resolve()
          await release.promise
        }
      } finally {
        if (session.nativeSessionId === failedSessionId) detached.resolve()
      }
    })
    const failure = new DomainError('NATIVE_BATCH_PUBLICATION_FAILED', 'Injected batch publication failure.', 503)
    const append = f.runs.appendNativeEvents.bind(f.runs)
    vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (frames, ...args) => {
      if (frames.some((frame) => frame.event.type === 'native.notification')) throw failure
      return append(frames, ...args)
    })
    const cancel = vi.spyOn(f.provider, 'cancel')
    let observed: unknown
    let settled = false
    const task = f.engine.start(f.f.run.id).catch((error: unknown) => { observed = error })
      .finally(() => { settled = true })
    try {
      await reading.promise
      await expect.poll(() => settled, { timeout: 2_000 }).toBe(true)
      await task
      expect(observed).toMatchObject({ code: failure.code })
      const lane = await f.repository.coordination.getLane('codex', failedSessionId!)
      expect(lane?.leaseToken).toBeUndefined()
      expect(lane?.currentTurnOrMessageId).toBe(`turn-${failedSessionId!.slice('native-'.length)}`)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('pending')
      expect(cancel).not.toHaveBeenCalled()
      expect(f.provider.closedSessions.has(failedSessionId!)).toBe(false)
      expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2 })
      release.resolve()
      await detached.promise
      await f.engine.reconcile()
      await f.engine.start(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, attaches: 0 })
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
      await (await graphParity(f.db.pool, f.f.scope)).compare()
      await f.engine.shutdown()
      const restarted = f.compose()
      await restarted.engine.reconcile()
      expect((await restarted.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, attaches: 0 })
    } finally {
      release.resolve()
      await task
    }
  }, 60_000)

  it('drains parallel output in bounded publications while Start and reconcile retain one task', async () => {
    const f = await checkpointRuntimeFixture(2, 1, { approvalNodeIds: [] })
    closes.push(f.close)
    const entered = deferred()
    const release = deferred()
    const original = f.provider.startTurn.bind(f.provider)
    const batches: number[] = []
    const append = f.runs.appendNativeEvents.bind(f.runs)
    vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (...args) => {
      batches.push(args[0].length)
      return append(...args)
    })
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      const execution = await f.runs.getExecution(session.nativeSessionId.slice('native-'.length))
      for await (const event of original(session, input)) {
        yield event
        if (event.type !== 'turn.started' || execution?.workflowNodeId === f.f.version.entryNodeId) continue
        entered.resolve()
        await release.promise
        for (let index = 0; index < 256; index++) {
          yield { ...event, sequence: index + 10, type: 'native.notification',
            payload: { text: `stream-${index}` } }
        }
      }
    })
    const task = f.engine.start(f.f.run.id)
    try {
      await entered.promise
      expect(f.engine.start(f.f.run.id)).toBe(task)
      await f.engine.reconcile()
      expect(f.engine.start(f.f.run.id)).toBe(task)
      release.resolve()
      await task
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3 })
      expect(batches.every((count) => count > 0 && count <= 16)).toBe(true)
      expect(batches.filter((count) => count > 1).length).toBeGreaterThan(0)
      const raw = await f.db.pool.query<{ execution_id: string; record: { payload: { text: string } } }>(
        `select n.execution_id,n.record from harness_native_events n
         join harness_executions e on e.id=n.execution_id where e.run_id=$1
         and n.record->>'type'='native.notification' order by n.execution_id,n.sequence`, [f.f.run.id])
      expect(raw.rows).toHaveLength(512)
      for (const executionId of new Set(raw.rows.map((row) => row.execution_id))) {
        expect(raw.rows.filter((row) => row.execution_id === executionId).map((row) => row.record.payload.text))
          .toEqual(Array.from({ length: 256 }, (_, index) => `stream-${index}`))
      }
      const sources = await f.db.pool.query<{ count: number }>(
        `select count(*)::int as count from workflow_native_proofs p join run_graph_sources s
         on s.run_id=p.run_id and s.source_kind='native_event' and s.source_id=p.proof_id
         where p.run_id=$1 and p.record#>>'{original,event,type}'='native.notification'`, [f.f.run.id])
      expect(sources.rows[0]?.count).toBe(512)
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
      await (await graphParity(f.db.pool, f.f.scope)).compare()
      await assertOperatorReadback(f)
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3 })
    } finally {
      release.resolve()
      await task.catch(() => undefined)
    }
  }, 60_000)

  it('binds the original approval checkpoint after draining its streaming sibling', async () => {
    const source = makeCurrentWorkflowFixture('streaming-approval')
    const approvalNodeId = source.version.definition.nodes[1]!.id
    const f = await checkpointRuntimeFixture(2, 1, { fixture: source, approvalNodeIds: [approvalNodeId] })
    closes.push(f.close)
    const original = f.provider.startTurn.bind(f.provider)
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      const execution = await f.runs.getExecution(session.nativeSessionId.slice('native-'.length))
      for await (const event of original(session, input)) {
        yield event
        if (event.type !== 'turn.started' || !execution?.workflowNodeId.endsWith('-parallel')) continue
        for (let index = 0; index < 512; index++) {
          yield { ...event, sequence: index + 10, type: 'native.notification', payload: { text: `sibling-${index}` } }
        }
      }
    })
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction?.graphInterruptId).toBeTruthy()
    expect((await f.runs.get(f.f.run.id))?.executionState).toBe('waiting')
    const executions = await readCurrentExecutions(f.runs, f.f.run.id)
    expect(executions.find((item) => item.workflowNodeId.endsWith('-parallel'))?.result?.outcome).toBe('succeeded')
    const budget = await f.db.pool.query<{ active_started_at: Date | null; approval_wait_started_at: Date | null }>(
      'select active_started_at,approval_wait_started_at from approval_execution_state where execution_id=$1',
      [interaction!.executionId])
    expect(budget.rows[0]?.active_started_at).toBeNull()
    expect(budget.rows[0]?.approval_wait_started_at).not.toBeNull()
    const raw = await f.db.pool.query<{ count: number }>(
      `select count(*)::int as count from harness_native_events n join harness_executions e on e.id=n.execution_id
       where e.run_id=$1 and n.record->>'type'='native.notification'`, [f.f.run.id])
    expect(raw.rows[0]?.count).toBe(512)
    await f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(interaction!))
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1 })
    expect(await f.receipts()).toHaveLength(1)
    await (await graphParity(f.db.pool, f.f.scope)).compare()
  }, 60_000)
})
