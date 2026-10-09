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
import { graphFixture, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'

async function fixture(options: { beforeMigration?: number } = {}) {
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
  async function activity() {
    const response = await graphRpc(app, reader.token, 'tools/call', { name: 'run_activities_get_v1', arguments: request })
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
    const f = await fixture({ beforeMigration: 2026100901 })
    try {
      const ticket = await f.submit()
      expect((await f.activity()).items.filter(item => item.kind === 'job_work')).toEqual([])
      await applyApplicationMigrations(f.database.pool)
      const ci = (await f.activity()).items.filter(item => item.refs.jobExecutionId === ticket.executionId)
      expect(ci).toHaveLength(1)
      expect(ci[0]?.status).toBe('queued')
    } finally { await f.close() }
  }, 120000)
})
