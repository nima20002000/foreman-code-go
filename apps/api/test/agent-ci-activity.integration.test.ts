import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { RunActivitiesPageSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { readRunActivitySnapshot } from '../src/modules/runs/activitySnapshot.js'
import { withCurrentRunRead } from '../src/modules/runs/currentRead.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { agentCiActivityMigration } from '../src/infrastructure/agentCiActivityMigration.js'
import { graphFixture, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'

async function fixture(options: { deferMigration?: number } = {}) {
  const database = await currentDatabase(options)
  const graph = await graphFixture(database, { form: 'single', qualifiedReads: true })
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executionId = randomUUID()
  await database.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
    values($1,$2,$3,$4,1,$5::jsonb)`, [executionId, graph.run.id, node.id, node.agentId, JSON.stringify({
    id: executionId, runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId, attempt: 1,
    agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
    state: 'running', input: {}, createdAt: graph.run.createdAt, startedAt: graph.run.createdAt,
  })])
  const settings = await graph.credential([{ actions: ['settings:read', 'settings:update'], scope: {} }])
  const jobs = await buildQueueFixture(database.pool, graph.writer.principal, {
    workspaceId: graph.scope.workspaceId, settingsPrincipal: settings.principal,
  })
  const locations = new WorkspaceLocationService(database.pool, graph.commands)
  const runs = new RunManagementService(database.pool, graph.commands, {} as never, {} as never, locations)
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: graph.access, services: { commands: graph.commands, workflows: graph.workflows, runs } as never } })
  const reader = await graph.credential([{ actions: ['runs:read'], scope: { runIds: [graph.run.id] } }])
  const denied = await graph.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
  const origin = { workflowId: graph.scope.workflowId, runId: graph.run.id, agentId: node.agentId, executionId }
  const request = { workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100 }
  const snapshotScope = { workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId,
    runId: graph.run.id, workflowVersionId: graph.version.id }
  async function activity(page: { cursor?: string; limit?: number } = {}) {
    const response = await graphRpc(app, reader.token, 'tools/call', {
      name: 'run_activities_get_v1', arguments: { ...request, ...page },
    })
    expect(response.result?.isError).not.toBe(true)
    return RunActivitiesPageSchema.parse(graphRpcValue(response.result))
  }
  const snapshot = () => withCurrentRunRead(database.pool, reader.principal, graph.scope.workspaceId,
    graph.run.id, 'runs:read', (sql, accepted) => readRunActivitySnapshot(
      sql as unknown as Pick<pg.PoolClient, 'query'>, snapshotScope, accepted.version))
  async function submit() {
    const definition = await jobs.save()
    const admitted = await jobs.jobs.enqueue(graph.writer.principal, 'mcp', graph.scope.workspaceId, {
      commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
    }, { initiatingAgent: origin })
    if (admitted.kind !== 'pending-admission') throw new Error('The fixture begins with unavailable capacity.')
    await jobs.jobs.wakeQueue()
    return jobs.jobs.getQueueTicket(graph.writer.principal, graph.scope.workspaceId, admitted.ticket.id)
  }
  return { database, graph, node, executionId, jobs, app, reader, denied, request, activity, snapshot, submit,
    async close() {
      await jobs.jobs.closeQueue()
      await app.close()
      await graph.app.close()
      await database.close()
    } }
}

async function anotherWorkflow(f: Awaited<ReturnType<typeof fixture>>) {
  const created = (await f.graph.workflows.create(f.graph.writer.principal, 'mcp', {
    workspaceId: f.graph.scope.workspaceId, commandId: randomUUID(), name: 'Other CI workflow',
  })).value
  const definition = { ...f.graph.version.definition, id: created.workflow.id,
    createdAt: created.workflow.createdAt!, updatedAt: created.workflow.updatedAt! }
  delete definition.version
  const saved = (await f.graph.workflows.current.save(f.graph.writer.principal, 'mcp', {
    workspaceId: f.graph.scope.workspaceId, workflowId: created.workflow.id, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: f.graph.version.agentConfigurationVersionIds, expectedLocationRevision: 1,
    graph: definition,
  })).value
  const next = makeCurrentWorkflowFixture(randomUUID(), 'single')
  return insertCurrentRunFixture(f.database.pool, { ...next, configurations: f.graph.f.configurations,
    run: { ...f.graph.f.run, id: next.run.id } }, saved, f.graph.writer.principal.id)
}

describe.skipIf(!postgresEnabled)('Agent CI in public Run activity', () => {
  it('serializes same-Run CI commits so incremental cursors see both events exactly once', async () => {
    const f = await fixture()
    const first = await f.database.pool.connect()
    const second = await f.database.pool.connect()
    let secondUpdate: Promise<pg.QueryResult> | undefined
    try {
      const ticketA = await f.submit()
      const ticketB = await f.submit()
      const initial = await f.activity()
      const before = (await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence',
        [f.graph.run.id])).rows
      await first.query('begin')
      await second.query('begin')
      const holder = (await first.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const waiter = (await second.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const canceledAt = new Date().toISOString()
      const cancel = `update job_admission_queue set record=record||jsonb_build_object(
        'revision',(record->>'revision')::bigint+1,
        'state','terminal','terminalReason','cancelled',
        'cancelRequestedAt',$2::text,'finishedAt',$2::text) where id=$1`
      await first.query(cancel, [ticketA.id, canceledAt])
      secondUpdate = second.query(cancel, [ticketB.id, canceledAt])
      const pending = secondUpdate.then(() => ({ error: null }), error => ({ error }))
      const deadline = Date.now() + 4000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        blocked = (await f.database.pool.query<{ blocked: boolean }>(
          'select $2::integer=any(pg_blocking_pids($1::integer)) as blocked', [waiter, holder])).rows[0]!.blocked
        if (!blocked) await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      const during = await f.activity({ cursor: initial.nextCursor })
      expect(during.items).toEqual([])
      await first.query('commit')
      const settled = await pending
      if (settled.error) throw settled.error
      const afterFirst = await f.activity({ cursor: during.nextCursor, limit: 1 })
      expect(afterFirst.items).toMatchObject([{ status: 'canceled', refs: { jobExecutionId: ticketA.executionId } }])
      await second.query('commit')
      const canceledTickets = await f.database.pool.query<{ record: Record<string, unknown> }>(
        'select record from job_admission_queue where id=any($1::uuid[])', [[ticketA.id, ticketB.id]])
      expect(canceledTickets.rows).toHaveLength(2)
      for (const ticket of [ticketA, ticketB]) {
        const saved = canceledTickets.rows.find(row => row.record.id === ticket.id)?.record
        expect(saved).toMatchObject({
          id: ticket.id, revision: ticket.revision + 1, state: 'terminal', terminalReason: 'cancelled',
          cancelRequestedAt: canceledAt, finishedAt: canceledAt,
        })
      }
      const afterSecond = await f.activity({ cursor: afterFirst.nextCursor, limit: 1 })
      expect(afterSecond.items).toMatchObject([{ status: 'canceled', refs: { jobExecutionId: ticketB.executionId } }])
      const delivered = [...afterFirst.items, ...afterSecond.items]
      expect(new Set(delivered.map(item => item.id)).size).toBe(2)
      expect(BigInt(delivered[1]!.sequence)).toBeGreaterThan(BigInt(delivered[0]!.sequence))
      expect((await f.activity({ cursor: afterSecond.nextCursor })).items).toEqual([])
      const retained = (await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence limit $2',
        [f.graph.run.id, before.length])).rows
      expect(retained).toEqual(before)
      const denied = await graphRpc(f.app, f.denied.token, 'tools/call', {
        name: 'run_activities_get_v1', arguments: { ...f.request, cursor: initial.nextCursor },
      })
      expect(denied.error || denied.result?.isError).toBeTruthy()
    } finally {
      await first.query('rollback')
      // Drain the blocked query before releasing its connection after a failed assertion.
      if (secondUpdate) await Promise.allSettled([secondUpdate])
      await second.query('rollback')
      first.release()
      second.release()
      await f.close()
    }
  }, 120000)

  it('publishes queued, running and completed CI with its initiating Agent through authenticated MCP', async () => {
    const f = await fixture()
    try {
      const ticket = await f.submit()
      const queued = await f.activity()
      expect(queued.items).toContainEqual(expect.objectContaining({
        kind: 'job_work', status: 'queued', actor: expect.objectContaining({ agentId: f.node.agentId, nodeId: f.node.id }),
        refs: expect.objectContaining({ executionId: f.executionId, jobExecutionId: ticket.executionId }),
      }))
      expect((await f.snapshot()).queued).toContainEqual(expect.objectContaining({ executionId: ticket.executionId }))
      f.jobs.online()
      await f.jobs.jobs.wakeQueue()
      await f.jobs.jobs.closeQueue()
      const execution = await f.jobs.jobs.getExecution(f.graph.writer.principal, f.graph.scope.workspaceId, ticket.executionId)
      const fence = { attemptId: execution.attemptId, owner: execution.owner }
      await f.jobs.worker.settleProcess(f.graph.scope.workspaceId, execution.id, fence, {
        process: { phase: 'running', outcome: null, exitCode: null, signal: null, processStopped: false },
        startedAt: execution.createdAt, finishedAt: null,
      })
      expect((await f.activity()).items).toContainEqual(expect.objectContaining({
        kind: 'job_work', status: 'running', refs: expect.objectContaining({ jobExecutionId: execution.id }),
      }))
      expect((await f.snapshot()).active).toContainEqual(expect.objectContaining({
        ref: expect.objectContaining({ executionId: execution.id }), phase: 'active', evidence: 'confirmed',
      }))
      await f.jobs.complete(execution.id)
      const finished = await f.activity()
      expect(finished.items).toContainEqual(expect.objectContaining({
        kind: 'job_work', status: 'completed', refs: expect.objectContaining({ jobExecutionId: execution.id }),
      }))
      expect((await f.snapshot()).active.some(item => item.ref.kind === 'execution'
        && item.ref.executionId === execution.id)).toBe(false)
      const reread = await f.activity()
      expect(reread.items).toEqual(finished.items)
      const blocked = await graphRpc(f.app, f.denied.token, 'tools/call', {
        name: 'run_activities_get_v1', arguments: f.request,
      })
      expect(blocked.error || blocked.result?.isError).toBeTruthy()
      expect(JSON.stringify(blocked)).not.toContain(execution.id)
    } finally { await f.close() }
  }, 120000)

  it('retains queue cancellation and failed process outcomes without mixing Runs', async () => {
    const f = await fixture()
    try {
      const cancelled = await f.submit()
      await f.jobs.jobs.cancelQueued(f.graph.writer.principal, 'mcp', f.graph.scope.workspaceId, {
        ticketId: cancelled.id, expectedRevision: cancelled.revision, commandId: randomUUID(),
      })
      expect((await f.activity()).items).toContainEqual(expect.objectContaining({
        kind: 'job_work', status: 'canceled', refs: expect.objectContaining({ jobExecutionId: cancelled.executionId }),
      }))
      const failed = await f.submit()
      f.jobs.online()
      await f.jobs.jobs.wakeQueue()
      await f.jobs.jobs.closeQueue()
      const execution = await f.jobs.jobs.getExecution(f.graph.writer.principal, f.graph.scope.workspaceId, failed.executionId)
      await f.jobs.worker.settleProcess(f.graph.scope.workspaceId, execution.id,
        { attemptId: execution.attemptId, owner: execution.owner }, {
          process: { phase: 'terminal', outcome: 'build_failed', exitCode: 1, signal: null, processStopped: true },
          startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
        })
      const page = await f.activity()
      expect(page.items).toContainEqual(expect.objectContaining({
        kind: 'job_work', status: 'failed', severity: 'error', refs: expect.objectContaining({ jobExecutionId: execution.id }),
      }))
      const foreign = await anotherWorkflow(f)
      const response = await graphRpc(f.app, f.graph.writer.token, 'tools/call', {
        name: 'run_activities_get_v1', arguments: { workspaceId: foreign.scope.workspaceId, runId: foreign.run.id },
      })
      const foreignPage = RunActivitiesPageSchema.parse(graphRpcValue(response.result))
      expect(foreignPage.items.every(item => item.refs.jobExecutionId !== failed.executionId
        && item.refs.jobExecutionId !== cancelled.executionId)).toBe(true)
      expect(page.items.every(item => item.scope.runId === f.graph.run.id)).toBe(true)
    } finally { await f.close() }
  }, 120000)

  it('adds a present-state observation for retained tickets without inventing earlier CI transitions', async () => {
    // Current queue services need the other migrations while activity backfill remains pending.
    const f = await fixture({ deferMigration: agentCiActivityMigration.version })
    try {
      const ticket = await f.submit()
      expect((await f.activity()).items.filter(item => item.kind === 'job_work')).toEqual([])
      await applyApplicationMigrations(f.database.pool)
      const ci = (await f.activity()).items.filter(item => item.refs.jobExecutionId === ticket.executionId)
      expect(ci).toHaveLength(1)
      expect(ci[0]?.status).toBe('queued')
      await applyApplicationMigrations(f.database.pool)
      expect((await f.activity()).items.filter(item => item.refs.jobExecutionId === ticket.executionId)).toEqual(ci)
    } finally { await f.close() }
  }, 120000)
})
