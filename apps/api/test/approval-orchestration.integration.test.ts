import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { approvalReviewCuts } from './helpers/approvalReviewCuts.js'
import { br1002At } from './helpers/wave25Br1002Cuts.js'
import { agent3Database, deferred, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  it('resumes the exact interrupted execution, rejects forged options and replays without repeating native effects', async () => {
    const f = await checkpointRuntimeFixture()
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } } })
    try {
      await f.engine.start(f.f.run.id)
      const [pending] = await f.pending()
      const executions = (await f.db.pool.query('select record from harness_executions where run_id=$1 order by id', [f.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))
      expect(executions).toHaveLength(2)
      expect(executions.find((execution) => execution.id === pending!.executionId)?.nativeSessionId)
        .toBe(pending!.nativeSessionId)
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 0 })
      expect((await app.inject({ method: 'GET', url: '/api/interactions?limit=10' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `/api/interactions/${pending!.id}/respond`, payload: approvalResponse(pending!) })).statusCode).toBe(404)
      await expect(f.service.respond({ kind: 'user', principal: f.principal }, { ...approvalResponse(pending!), optionId: 'forged' }))
        .rejects.toMatchObject({ code: 'INTERACTION_OPTION_INVALID' })
      expect((await f.runs.get(f.f.run.id))?.executionState).toBe('waiting')
      const response = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))
      expect(response.interaction.deliveryState).toBe('delivered')
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(((await f.db.pool.query('select record from harness_executions where run_id=$1 order by id', [f.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))).map((e) => [e.id, e.nativeSessionId]))
        .toEqual(executions.map((e) => [e.id, e.nativeSessionId]))
      expect((await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))).replayed).toBe(true)
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 1 })
    } finally { await app.close(); await f.close() }
  }, 60000)

  it('targets two parallel interrupt IDs without respawning either branch or its predecessor', async () => {
    const f = await checkpointRuntimeFixture(2)
    try {
      await f.engine.start(f.f.run.id)
      const pending = await f.pending()
      expect(pending).toHaveLength(2)
      expect(new Set(pending.map((i) => i.graphInterruptId)).size).toBe(2)
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending[0]!))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('pending')
      expect(await f.repository.get(pending[1]!.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending[1]!))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.provider.counts).toMatchObject({ starts: 3, sessions: 3, responses: 2 })
      expect(await f.receipts()).toHaveLength(2)
    } finally { await f.close() }
  }, 60000)

  it('delivers an authenticated designated reviewer MCP decision only after exact native review settlement', async () => {
    const f = await routedApprovalFixture()
    const commands = new PostgresCommandCoordinator(f.db.pool)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      appMcp: { access: f.access, interactions: new PostgresAppInteractionService(f.db.pool, f.repository, commands, f.service) },
      operator: { access: f.access, services: { commands, interactions: new OperatorInteractionService(f.service) } as never } })
    const clients: Client[] = []
    const appendHistory = f.coordination.appendReviewNativeHistory.bind(f.coordination)
    const cuts = approvalReviewCuts(f)
    const beforeHistory = deferred()
    const afterHistory = deferred()
    const publishHistory = deferred()
    const finishHistory = deferred()
    const historySpy = vi.spyOn(f.coordination, 'appendReviewNativeHistory').mockImplementation(async (...args) => {
      if (!args[1].some((event) => event.type === 'thread.reconciled')) return appendHistory(...args)
      beforeHistory.resolve()
      await publishHistory.promise
      await appendHistory(...args)
      afterHistory.resolve()
      await finishHistory.promise
    })
    let dispatch: Promise<unknown> | undefined
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(path: string, token: string) {
        const client = new Client({ name: 'current-approval-proof', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL(path, address), { authProvider: { token: async () => token } }))
        return client
      }
      const reader = await f.access.issue({ name: 'Read approvals', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['interactions:read'], scope: { runIds: [f.run.id] } }] })
      const operator = await connect('/mcp', reader.token)
      const denied = await f.credentials.issueForExecution(f.requester.id)
      const worker = await connect('/mcp', denied.environment.variables.GRAPHQL_MCP_TOKEN!)
      // Neither role lists interaction_respond; a direct call is refused before the decision service.
      for (const [client, code] of [[worker, 'ROLE_NOT_ALLOWED'], [operator, 'ACCESS_DENIED']] as const) {
        const refused = await client.callTool({ name: 'interaction_respond', arguments: approvalResponse(f.interaction) })
        expect(refused.isError).toBe(true)
        const body = refused.content.find((item) => item.type === 'text')
        expect(body?.type).toBe('text')
        expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code } })
      }
      expect(f.counts().responses).toBe(0)
      dispatch = f.native.reviewers.dispatchNext(f.reviewerId, 'current-mcp-proof')
      void dispatch.catch(() => undefined)
      await br1002At(cuts.started.promise, dispatch)
      const credential = await f.credentials.issueForReviewer(f.reviewer.id)
      const reviewer = await connect('/mcp', credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      const input = approvalResponse(f.interaction)
      const stale = await reviewer.callTool({ name: 'interaction_respond', arguments: { ...input, expectedRevision: 999 } })
      expect(stale.isError).toBe(true)
      expect(f.counts().responses).toBe(0)
      const response = await reviewer.callTool({ name: 'interaction_respond', arguments: input })
      expect(response.isError).not.toBe(true)
      expect(decodeMcpToolResult(response)).toMatchObject({ interaction: { deliveryState: 'pending' } })
      expect(f.counts().responses).toBe(0)
      cuts.continueStart.resolve()
      f.provider.completeReview(f.job.correlationId, f.reviewer.nativeSessionId!)
      await br1002At(cuts.assistant.promise, dispatch)
      cuts.continueAssistant.resolve()
      await br1002At(beforeHistory.promise, dispatch)
      expect(f.counts().responses).toBe(0)
      publishHistory.resolve()
      await br1002At(afterHistory.promise, dispatch)
      finishHistory.resolve()
      await dispatch
      expect((await f.service.recover({ limit: 10 })).errors).toEqual([])
      expect(await f.repository.get(input.interactionId)).toMatchObject({ deliveryState: 'delivered' })
      expect(f.counts().responses).toBe(1)
      expect(decodeMcpToolResult((await operator.callTool({ name: 'interaction_get', arguments: { interactionId: input.interactionId } }))))
        .toMatchObject({ interaction: { deliveryState: 'delivered' } })
      // The provider fixture retains the requester terminal result only in history.
      // Decision and graph resume are durable; Run completion needs later native observation.
      expect((await f.db.pool.query<{ state: string }>(
        'select state from interaction_graph_resumes where interaction_id=$1', [input.interactionId])).rows[0]?.state).toBe('resumed')
      expect((await f.runs.get(f.run.id))?.outcome).toBe('pending')
    } finally {
      cuts.release()
      publishHistory.resolve()
      finishHistory.resolve()
      await dispatch?.catch(() => undefined)
      cuts.restore()
      historySpy.mockRestore()
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
      await f.close()
    }
  }, 60000)

  it.each(['transitive', 'unconnected', 'same_agent_other_node'] as const)('rejects %s approval topology during current Save before it can grant reviewer authority', async (topology) => {
    const db = await agent3Database()
    try {
      const f = makeCurrentWorkflowFixture(randomUUID(), 'approval')
      f.configurations[0]!.harness = structuredClone(approvalFixture().configurations[0]!.harness)
      await seedAgent3(db.pool, db.directory, f, { run: false })
      const access = new PostgresAccessService(db.pool)
      const writer = await access.issue({ name: 'Approval author', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const workflows = new WorkflowManagementService(db.pool, new PostgresCommandCoordinator(db.pool))
      const managed = await workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
      const graph = structuredClone(f.version.definition)
      const assignment = graph.edges.find((edge) => edge.kind === 'approval')!
      if (topology === 'unconnected') graph.edges = graph.edges.filter((edge) => edge.id !== assignment.id)
      if (topology === 'transitive') assignment.source = assignment.target
      if (topology === 'same_agent_other_node') graph.nodes.push({ ...graph.nodes[1]!, id: 'same-agent-other-occurrence' })
      const before = (await db.pool.query('select id from workflow_versions')).rows
      await expect(workflows.current.save(writer.principal, 'mcp', { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
        commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
        expectedWorkflowVersionId: f.version.id, expectedLocationRevision: 1,
        expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, graph })).rejects.toThrow()
      expect((await db.pool.query('select id from workflow_versions')).rows).toEqual(before)
      expect((await db.pool.query('select principal_id from worker_credential_bindings')).rows).toHaveLength(0)
    } finally { await db.close() }
  }, 60000)

  it('keeps a busy reviewer pending and gives exactly one contender its durable job lease', async () => {
    const f = await routedApprovalFixture()
    let busyLaneId: string | undefined
    try {
      const lane = (await f.coordination.getLane('codex', f.reviewer.nativeSessionId!))!
      await f.coordination.claimLane(lane.id, lane.revision, f.reviewerId, 'busy-writer', new Date(Date.now() + 60000).toISOString(), 'active-turn')
      busyLaneId = lane.id
      expect(await f.native.reviewers.dispatchNext(f.reviewerId, 'busy-probe')).toMatchObject({ state: 'blocked_busy' })
      expect(f.counts().prompts).toBe(2)
      const blocked = await f.coordination.findReviewJob(f.job.interactionId, f.reviewerId)
      expect(blocked?.retryAfter).toBeDefined()
      const early = await Promise.allSettled(['early-first', 'early-second'].map((owner) =>
        f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`, new Date(Date.now() + 60000).toISOString())))
      expect(early.every((result) => result.status === 'rejected')).toBe(true)
      await delay(Math.max(0, Date.parse(blocked!.retryAfter!) - Date.now() + 50))
      const claims = await Promise.allSettled(['first', 'second'].map((owner) => f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`, new Date(Date.now() + 60000).toISOString())))
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1)
    } finally {
      if (busyLaneId) await f.coordination.releaseLane(busyLaneId, 'busy-writer', { observedStatus: 'idle' })
      try {
        await expect(f.engine.shutdown()).resolves.toBeUndefined()
        expect(await f.runs.get(f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
        expect(await f.repository.get(f.interaction.id)).toMatchObject({ status: 'pending' })
        expect(f.counts()).toMatchObject({ prompts: 2, responses: 0 })
      } finally {
        await f.close()
      }
    }
  }, 60000)
})
