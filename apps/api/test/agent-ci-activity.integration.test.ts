import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostRun, type CiRunInput } from '@foreman-code/contracts'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { AcceptedRepeatStartV1Schema, RunActivitiesPageSchema, makeCurrentWorkflowFixture,
  type AcceptedRepeatStartV1 } from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { hostCiActivityMigration } from '../src/infrastructure/hostCiActivityMigration.js'
import { changeRunState, graphFixture, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { acceptRunAuthority, bindRunAuthority } from '../src/modules/access/runAuthority.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'

async function admitCiRun(pool: pg.Pool, input: AcceptedRepeatStartV1, principal: ManagementPrincipal) {
  return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
    const client = sql as unknown as pg.PoolClient
    const authority = await acceptRunAuthority(client, principal)
    const accepted = AcceptedRepeatStartV1Schema.parse({
      run: { ...input.run, authorizationPrincipalId: authority.principal.id },
      snapshot: { ...input.snapshot, authorizationPrincipalId: authority.principal.id },
    })
    await insertRepeatRun(sql, accepted, repeatStartPublication)
    await bindRunAuthority(client, accepted.run.id, authority)
    return accepted
  }))
}

async function fixture(options: { deferMigration?: number } = {}) {
  const database = await currentDatabase(options)
  const graph = await graphFixture(database, { form: 'single', qualifiedReads: true, insert: false })
  graph.accepted = await admitCiRun(database.pool, graph.accepted, graph.writer.principal)
  graph.run = graph.accepted.run
  graph.f.run = graph.run
  await changeRunState(database, graph, 'running')
  const node = agentWorkflowNode(graph.version.definition.nodes[0])
  const executionId = randomUUID()
  const insertExecution = async (id: string, runId: string) => database.pool.query(`insert into harness_executions
    (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
  [id, runId, node.id, node.agentId, JSON.stringify({ id, runId, workflowNodeId: node.id,
    agentId: node.agentId, attempt: 1, agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
    state: 'starting', input: {}, createdAt: graph.run.createdAt })])
  await insertExecution(executionId, graph.run.id)
  await database.pool.query(`update workspaces set record=record||$2::jsonb where id=$1`,
    [graph.scope.workspaceId, JSON.stringify({ repository: { provider: 'github', owner: 'example',
      name: 'project', defaultBranch: 'main' } })])
  let online = false
  const computer: HostCiComputer = { key: 'synthetic-build', hostRef: { kind: 'main', mainId: randomUUID() },
    label: 'Build computer', priority: 1 }
  const hostRuns = new Map<string, CiHostRun>()
  const endpoint: HostCiEndpoint = {
    computers: async () => online ? [computer] : [],
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, runs: [...hostRuns.values()] }
      if (request.operation === 'start') {
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        hostRuns.set(run.runId, run)
        return { operation: 'start', run }
      }
      const run = hostRuns.get(request.runId)!
      if (request.operation === 'cancel') {
        const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString() }
        hostRuns.set(run.runId, canceled)
        return { operation: 'cancel', run: canceled }
      }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    },
  }
  const ci = new HostCiService(database.pool, graph.commands, new RunCiAuthority(database.pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => 'a'.repeat(40),
  }, endpoint)
  const locations = new WorkspaceLocationService(database.pool, graph.commands)
  const runs = new RunManagementService(database.pool, graph.commands, {} as never, {} as never, locations)
  const credentials = new Wave25WorkerCredentialService(database.pool, graph.access)
  const worker = await credentials.issueForExecution(executionId)
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: { access: graph.access, interactions: new PostgresAppInteractionService(database.pool, {} as never, graph.commands) },
    operator: { access: graph.access, services: { commands: graph.commands, workflows: graph.workflows, runs, ci } as never } })
  const reader = await graph.credential([{ actions: ['runs:read'], scope: { runIds: [graph.run.id] } }])
  const denied = await graph.credential([{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }])
  const request = { workspaceId: graph.scope.workspaceId, runId: graph.run.id, limit: 100 }
  async function call(token: string, name: string, args: Record<string, unknown>) {
    return graphRpc(app, token, 'tools/call', { name, arguments: args })
  }
  async function value(token: string, name: string, args: Record<string, unknown>) {
    const response = await call(token, name, args)
    expect(response.error).toBeUndefined()
    expect(response.result?.isError).not.toBe(true)
    return graphRpcValue(response.result)
  }
  const workerToken = worker.environment.variables.GRAPHQL_MCP_TOKEN!
  const submit = async (input: Partial<CiRunInput> = {}) => {
    const started = CiRunOutputSchema.parse(await value(workerToken, 'ci_run', {
      suite: 'integration', commandId: randomUUID(), ...input,
    }))
    await ci.dispatch()
    return started
  }
  const activity = async (page: { cursor?: string; limit?: number } = {}) =>
    RunActivitiesPageSchema.parse(await value(reader.token, 'run_activities_get_v1', { ...request, ...page }))
  const boardInput = { workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId, runId: graph.run.id }
  const board = async () => RunBoardSnapshotGetResultSchema.parse(
    await value(reader.token, 'run_board_snapshot_get', boardInput))
  const get = async (ticketId: string) => CiGetOutputSchema.parse(await value(workerToken, 'ci_get', { ticketId }))
  const finish = (ticketId: string, state: 'passed' | 'failed' | 'lost') => {
    const run = hostRuns.get(ticketId)!
    hostRuns.set(ticketId, { ...run, state, exitCode: state === 'passed' ? 0 : 1,
      finishedAt: new Date().toISOString() })
  }
  return { database, graph, node, executionId, ci, app, reader, denied, request, boardInput, activity, board,
    submit, get, finish, call, value, workerToken, credentials, insertExecution, computer,
    online() { online = true },
    async close() {
      await ci.close()
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
  const foreign = await insertCurrentRunFixture(f.database.pool, { ...next, configurations: f.graph.f.configurations,
    run: { ...f.graph.f.run, id: next.run.id } }, saved, f.graph.writer.principal.id, { insert: false })
  const accepted = await admitCiRun(f.database.pool, foreign.accepted, f.graph.writer.principal)
  const admitted = { ...foreign, accepted, run: accepted.run }
  await changeRunState(f.database, { ...f.graph, ...admitted }, 'running')
  return admitted
}

const ciRef = (ticketId: string, executionId: string) => expect.objectContaining({ kind: 'ci', ticketId, executionId })

describe.skipIf(!postgresEnabled)('Agent Host CI in public Run activity', () => {
  it('publishes queued, running and completed CI through authenticated MCP and HTTP with persisted readback', async () => {
    const f = await fixture()
    try {
      const deniedStart = await f.call(f.reader.token, 'ci_run', { workspaceId: f.request.workspaceId,
        suite: 'integration', commandId: randomUUID() })
      expect(deniedStart.error || deniedStart.result?.isError).toBeTruthy()
      expect((await f.database.pool.query('select count(*)::int as count from ci_runs')).rows[0]!.count).toBe(0)
      const ticket = await f.submit()
      const queued = await f.activity()
      expect(queued.items).toContainEqual(expect.objectContaining({ kind: 'job_work', status: 'queued',
        actor: expect.objectContaining({ agentId: f.node.agentId, nodeId: f.node.id }),
        refs: expect.objectContaining({ executionId: f.executionId, ciTicketId: ticket.ticketId }) }))
      const initialBoard = await f.board()
      expect(initialBoard.activitySnapshot?.queued).toContainEqual(ciRef(ticket.ticketId, f.executionId))
      expect(initialBoard.activitySnapshot?.active).toContainEqual(expect.objectContaining({
        ref: ciRef(ticket.ticketId, f.executionId), phase: 'waiting', ci: expect.objectContaining({ state: 'queued' }) }))
      f.online()
      const running = await f.get(ticket.ticketId)
      expect(running.run.state).toBe('running')
      expect((await f.board()).activitySnapshot?.active).toContainEqual(expect.objectContaining({
        ref: ciRef(ticket.ticketId, f.executionId), phase: 'active', evidence: 'confirmed',
        ci: expect.objectContaining({ state: 'running', computer: expect.objectContaining({ label: 'Build computer' }) }) }))
      f.finish(ticket.ticketId, 'passed')
      const done = await f.get(ticket.ticketId)
      const stored = (await f.database.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
        [ticket.ticketId])).rows[0]!
      expect(CiRunRecordSchema.parse(stored.record)).toEqual(done.run)
      const history = await f.activity()
      expect(history.items.filter(item => item.refs.ciTicketId === ticket.ticketId).map(item => item.ci?.state))
        .toEqual(['queued', 'running', 'passed'])
      const finishedBoard = await f.board()
      expect(finishedBoard.snapshot).toEqual(initialBoard.snapshot)
      expect(finishedBoard.activitySnapshot?.active.some(work => work.ref.kind === 'ci')).toBe(false)
      expect(finishedBoard.activitySnapshot?.activities).toContainEqual(expect.objectContaining({
        owner: ciRef(ticket.ticketId, f.executionId), parent: expect.objectContaining({ executionId: f.executionId }),
        ci: expect.objectContaining({ state: 'passed', exitCode: 0 }) }))
      const headers = { authorization: `Bearer ${f.reader.token}` }
      const base = `/api/management/workspaces/${f.request.workspaceId}`
      const http = await f.app.inject({ method: 'GET', headers,
        url: `${base}/runs/${f.request.runId}/activities?limit=100` })
      expect(http.statusCode).toBe(200)
      expect(RunActivitiesPageSchema.parse(http.json())).toEqual(history)
      const boardHttp = await f.app.inject({ method: 'GET', headers,
        url: `${base}/workflows/${f.boardInput.workflowId}/runs/${f.request.runId}/snapshot` })
      expect(boardHttp.statusCode).toBe(200)
      expect(RunBoardSnapshotGetResultSchema.parse(boardHttp.json())).toEqual(finishedBoard)
      expect((await f.activity()).items).toEqual(history.items)
      for (const [tool, args] of [['run_activities_get_v1', f.request], ['run_board_snapshot_get', f.boardInput]] as const) {
        const blocked = await f.call(f.denied.token, tool, args)
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect(JSON.stringify(blocked)).not.toContain(ticket.ticketId)
      }
    } finally { await f.close() }
  }, 120000)

  it('keeps CI parts and partitions scoped to their Agent execution and workflow', async () => {
    const f = await fixture()
    try {
      const split = await f.submit({ partitions: 2 })
      const parts = await f.submit({ suite: 'build' })
      expect(split.partitions).toHaveLength(2)
      expect(parts.partitions).toHaveLength(2)
      const queued = await f.activity()
      const splitGroup = (await f.get(split.ticketId)).run.groupId
      expect(queued.items.filter(item => item.ci?.groupId === splitGroup)
        .map(item => item.ci?.partition?.index).sort()).toEqual([0, 1])
      expect(queued.items.filter(item => parts.partitions!.some(part => part.ticketId === item.refs.ciTicketId))
        .map(item => item.ci?.part).sort()).toEqual(['build-api', 'build-other'])
      const foreign = await anotherWorkflow(f)
      const foreignExecutionId = randomUUID()
      await f.insertExecution(foreignExecutionId, foreign.run.id)
      const foreignCredential = await f.credentials.issueForExecution(foreignExecutionId)
      const token = foreignCredential.environment.variables.GRAPHQL_MCP_TOKEN!
      const foreignTicket = CiRunOutputSchema.parse(await f.value(token, 'ci_run', {
        suite: 'install', commandId: randomUUID() }))
      await f.ci.dispatch()
      const foreignPage = RunActivitiesPageSchema.parse(await f.value(f.graph.writer.token, 'run_activities_get_v1', {
        workspaceId: foreign.scope.workspaceId, runId: foreign.run.id }))
      expect(foreignPage.items.filter(item => item.ci).map(item => item.refs.ciTicketId)).toEqual([foreignTicket.ticketId])
      expect((await f.activity()).items.some(item => item.refs.ciTicketId === foreignTicket.ticketId)).toBe(false)
      const foreignBoard = RunBoardSnapshotGetResultSchema.parse(await f.value(f.graph.writer.token,
        'run_board_snapshot_get', { workspaceId: foreign.scope.workspaceId,
          workflowId: foreign.scope.workflowId, runId: foreign.run.id }))
      expect(foreignBoard.activitySnapshot?.active.filter(work => work.ref.kind === 'ci').map(work => work.ref))
        .toEqual([expect.objectContaining({ executionId: foreignExecutionId, ticketId: foreignTicket.ticketId })])
      for (const tool of ['ci_get', 'ci_logs_read', 'ci_cancel']) {
        const blocked = await f.call(token, tool, { ticketId: split.ticketId })
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect(JSON.stringify(blocked)).not.toContain(split.ticketId)
      }
      expect((await f.get(split.ticketId)).run.state).toBe('queued')
      await expect(f.database.pool.query(`update ci_runs set record=jsonb_set(record,
        '{initiator,executionId}',to_jsonb($2::text)) where id=$1`, [split.ticketId, foreignExecutionId]))
        .rejects.toThrow('CI run ownership cannot change')
      expect((await f.get(split.ticketId)).run.initiator.executionId).toBe(f.executionId)
    } finally { await f.close() }
  }, 120000)

  it.each(['passed', 'failed', 'lost', 'canceled'] as const)('retains the %s terminal result and queued cancellation', async terminal => {
    const f = await fixture()
    try {
      const waiting = await f.submit()
      await f.value(f.workerToken, 'ci_cancel', { ticketId: waiting.ticketId })
      expect((await f.activity()).items).toContainEqual(expect.objectContaining({ status: 'canceled',
        refs: expect.objectContaining({ ciTicketId: waiting.ticketId }) }))
      const ticket = await f.submit()
      f.online()
      await f.get(ticket.ticketId)
      if (terminal === 'canceled') await f.value(f.workerToken, 'ci_cancel', { ticketId: ticket.ticketId })
      else f.finish(ticket.ticketId, terminal)
      expect((await f.get(ticket.ticketId)).run.state).toBe(terminal)
      const events = (await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)
      expect(events.map(item => item.ci?.state)).toEqual(['queued', 'running', terminal])
      expect(events.at(-1)?.status).toBe({ passed: 'completed', failed: 'failed', lost: 'unknown', canceled: 'canceled' }[terminal])
      expect((await f.board()).activitySnapshot?.active.some(work => work.ref.kind === 'ci')).toBe(false)
    } finally { await f.close() }
  }, 120000)

  it('serializes same-Run CI commits so incremental cursors see both events once', async () => {
    const f = await fixture()
    const first = await f.database.pool.connect()
    const second = await f.database.pool.connect()
    let secondUpdate: Promise<pg.QueryResult> | undefined
    try {
      const ticketA = await f.submit()
      const ticketB = await f.submit()
      const initial = await f.activity()
      const before = (await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence', [f.graph.run.id])).rows
      await first.query('begin')
      await second.query('begin')
      const holder = (await first.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const waiter = (await second.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const canceledAt = new Date().toISOString()
      const cancel = `update ci_runs set state='canceled',record=record||jsonb_build_object(
        'state','canceled','finishedAt',$2::text) where id=$1`
      await first.query(cancel, [ticketA.ticketId, canceledAt])
      secondUpdate = second.query(cancel, [ticketB.ticketId, canceledAt])
      const pending = secondUpdate.then(() => ({ error: null }), error => ({ error }))
      const deadline = Date.now() + 4000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        blocked = (await f.database.pool.query<{ blocked: boolean }>(
          'select $2::integer=any(pg_blocking_pids($1::integer)) as blocked', [waiter, holder])).rows[0]!.blocked
        if (!blocked) await setImmediate()
      }
      expect(blocked).toBe(true)
      const during = await f.activity({ cursor: initial.nextCursor })
      expect(during.items).toEqual([])
      await first.query('commit')
      const settled = await pending
      if (settled.error) throw settled.error
      const afterFirst = await f.activity({ cursor: during.nextCursor, limit: 1 })
      expect(afterFirst.items).toMatchObject([{ status: 'canceled', refs: { ciTicketId: ticketA.ticketId } }])
      await second.query('commit')
      const records = (await f.database.pool.query<{ record: unknown }>(
        'select record from ci_runs where id=any($1::uuid[])', [[ticketA.ticketId, ticketB.ticketId]])).rows
      expect(records.map(row => CiRunRecordSchema.parse(row.record))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ticketA.ticketId, state: 'canceled', finishedAt: canceledAt }),
        expect.objectContaining({ id: ticketB.ticketId, state: 'canceled', finishedAt: canceledAt }),
      ]))
      const afterSecond = await f.activity({ cursor: afterFirst.nextCursor, limit: 1 })
      expect(afterSecond.items).toMatchObject([{ status: 'canceled', refs: { ciTicketId: ticketB.ticketId } }])
      const delivered = [...afterFirst.items, ...afterSecond.items]
      expect(new Set(delivered.map(item => item.id)).size).toBe(2)
      expect(BigInt(delivered[1]!.sequence)).toBeGreaterThan(BigInt(delivered[0]!.sequence))
      expect((await f.activity({ cursor: afterSecond.nextCursor })).items).toEqual([])
      expect((await f.database.pool.query<{ sequence: string }>(
        'select sequence::text from run_activity where run_id=$1 order by run_activity.sequence limit $2',
        [f.graph.run.id, before.length])).rows).toEqual(before)
      const denied = await f.call(f.denied.token, 'run_activities_get_v1', { ...f.request, cursor: initial.nextCursor })
      expect(denied.error || denied.result?.isError).toBeTruthy()
    } finally {
      await first.query('rollback')
      if (secondUpdate) await Promise.allSettled([secondUpdate])
      await second.query('rollback')
      first.release()
      second.release()
      await f.close()
    }
  }, 120000)

  it('observes retained Host CI once without inventing earlier transitions', async () => {
    const f = await fixture({ deferMigration: hostCiActivityMigration.version })
    try {
      const ticket = await f.submit()
      expect((await f.activity()).items.filter(item => item.kind === 'job_work')).toEqual([])
      await applyApplicationMigrations(f.database.pool)
      const ci = (await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)
      expect(ci).toHaveLength(1)
      expect(ci[0]?.ci?.state).toBe('queued')
      await applyApplicationMigrations(f.database.pool)
      expect((await f.activity()).items.filter(item => item.refs.ciTicketId === ticket.ticketId)).toEqual(ci)
    } finally { await f.close() }
  }, 120000)
})
