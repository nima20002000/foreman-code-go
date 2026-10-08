import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkflowJobPageSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobAdmissionResultSchema } from '@foreman-code/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { workHandoffFixture } from './helpers/workHandoffFixture.js'

// Accepted Jobs are fixture data; reads use the authenticated application and real PostgreSQL.
describe.skipIf(!postgresEnabled)('workflow job history HTTP and Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let workflow: Awaited<ReturnType<typeof workHandoffFixture>>
  let queue: Awaited<ReturnType<typeof buildQueueFixture>>
  let access: PostgresAccessService
  let app: ReturnType<typeof buildApp>
  let address: string
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let denied: Awaited<ReturnType<PostgresAccessService['issue']>>
  let executions: JobExecutionRecord[]
  const clients: Client[] = []
  const path = () => `/api/management/workspaces/${workflow.run.workspaceId}/jobs/workflows/${workflow.run.workflowId}/executions`
  const headers = () => ({ authorization: `Bearer ${reader.token}` })
  async function connect(token: string) {
    const client = new Client({ name: 'workflow-history-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
  }
  const input = () => ({ workspaceId: workflow.run.workspaceId, workflowId: workflow.run.workflowId })
  beforeAll(async () => {
    database = await agent3Database()
    workflow = await workHandoffFixture(database.pool, randomUUID(), version => version)
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Job author', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ scope: {},
        actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'settings:read', 'settings:update'] }] })
    reader = await access.issue({ name: 'Workflow history reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['jobs:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], workflowIds: [workflow.run.workflowId] } }] })
    denied = await access.issue({ name: 'Other workflow reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['jobs:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], workflowIds: ['foreign'] } }] })
    queue = await buildQueueFixture(database.pool, writer.principal, { workspaceId: workflow.run.workspaceId })
    queue.online()
    const definition = await queue.save(queue.computers[0]!.candidate.spec)
    const admission = JobAdmissionResultSchema.parse(await queue.jobs.enqueue(writer.principal, 'http',
      workflow.run.workspaceId, { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
    if (admission.kind === 'retained-execution') throw new Error('Fresh command reused a legacy execution')
    await queue.jobs.wakeQueue()
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    const ticket = await queue.jobs.getQueueTicket(writer.principal, workflow.run.workspaceId, ticketId)
    await queue.complete(ticket.executionId)
    const original = await queue.jobs.getExecution(writer.principal, workflow.run.workspaceId, ticket.executionId)
    // Same-time executions exercise the cursor tie-breaker and both provenance paths.
    executions = Array.from({ length: 52 }, (_, index) => {
      const value = { ...original, id: `history-${String(index).padStart(3, '0')}`,
        operationId: randomUUID(), attemptId: randomUUID(), createdAt: '2026-10-01T00:00:00Z' }
      if (index % 2 === 0) return { ...value, workflow: {
        workflowId: workflow.run.workflowId, runId: workflow.run.id, nodeId: 'job-node', nodeExecutionId: `node-${index}`,
      } }
      return { ...value, initiatingAgent: { workflowId: workflow.run.workflowId, runId: workflow.run.id,
        agentId: 'agent-a', executionId: `agent-${index}` } }
    })
    const unrelated: JobExecutionRecord[] = [
      { ...original, id: 'orphan-run', operationId: randomUUID(), attemptId: randomUUID(),
        initiatingAgent: { workflowId: workflow.run.workflowId, runId: 'missing-run',
          agentId: 'agent-a', executionId: 'foreign-agent-exec' } },
      { ...original, id: 'foreign-workflow', operationId: randomUUID(), attemptId: randomUUID(),
        workflow: { workflowId: 'foreign', runId: workflow.run.id, nodeId: 'job-node', nodeExecutionId: 'foreign-node' } },
    ]
    for (const value of [...executions, ...unrelated]) {
      await database.pool.query(`insert into job_executions
        (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
        values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [value.id, value.workspaceId,
        value.acceptedSpec.definitionVersionId, value.operationId, value.attemptId, JSON.stringify(value),
        JSON.stringify(value.acceptedSpec), writer.principal.id])
    }
    await queue.jobs.saveDefinition(writer.principal, 'http', workflow.run.workspaceId, {
      commandId: randomUUID(), id: definition.id, expectedRevision: 1,
      name: 'Renamed after execution', spec: definition.spec,
    })
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: queue.jobs, commands: queue.commands,
        workflows: new WorkflowManagementService(database.pool, queue.commands) } as unknown as OperatorServices } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await queue?.jobs.closeQueue()
    await workflow?.close()
    await database?.close()
  })

  it('reads both provenance paths, immutable names and every page in newest order', async () => {
    const firstHttp = await app.inject({ method: 'GET', url: path(), headers: headers() })
    expect(firstHttp.statusCode).toBe(200)
    const first = WorkflowJobPageSchema.parse(firstHttp.json())
    expect(first.items).toHaveLength(50)
    expect(first.items.every(item => item.name === 'Queued build')).toBe(true)
    expect(first.items.some(item => item.execution.workflow)).toBe(true)
    expect(first.items.some(item => item.execution.initiatingAgent)).toBe(true)
    const client = await connect(reader.token)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === 'job_workflow_list')).toBe(true)
    const firstMcp = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(firstMcp.isError).not.toBe(true)
    expect(firstMcp.structuredContent).toEqual(first)
    const second = await client.callTool({ name: 'job_workflow_list', arguments: { ...input(), cursor: first.nextCursor } })
    expect(second.isError).not.toBe(true)
    const last = WorkflowJobPageSchema.parse(second.structuredContent)
    expect(last.items).toHaveLength(2)
    expect(last.nextCursor).toBeNull()
    const ids = [...first.items, ...last.items].map(item => item.execution.id)
    expect(ids).toEqual(executions.map(item => item.id).reverse())
    const persisted = await queue.jobs.repository.execution(database.pool, workflow.run.workspaceId, ids[0]!)
    expect(first.items[0]!.execution).toEqual(persisted)
    const lastHttp = await app.inject({ method: 'GET', headers: headers(),
      url: `${path()}?cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}` })
    expect(lastHttp.json()).toEqual(last)
  })

  it('returns empty history for a saved workflow without linked jobs', async () => {
    const emptyId = randomUUID()
    await database.pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [emptyId, workflow.run.workspaceId, JSON.stringify({ id: emptyId, workspaceId: workflow.run.workspaceId })])
    const client = await connect(writer.token)
    const result = await client.callTool({ name: 'job_workflow_list', arguments: { ...input(), workflowId: emptyId } })
    const expected = { ...input(), workflowId: emptyId, items: [], nextCursor: null }
    expect(result.structuredContent).toEqual(expected)
    const http = await app.inject({ method: 'GET',
      url: path().replace(workflow.run.workflowId, emptyId),
      headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(expected)
  })

  it('denies other-workflow callers over HTTP and MCP and audits denial', async () => {
    const http = await app.inject({ method: 'GET', url: path(), headers: { authorization: `Bearer ${denied.token}` } })
    expect(http.statusCode).toBe(403)
    const client = await connect(denied.token)
    const result = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
    const audits = await database.pool.query('select source from management_audit where principal_id=$1 and outcome=$2',
      [denied.principal.id, 'denied'])
    expect(audits.rows.map(row => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
  })

  it('rechecks live grants on an existing authenticated MCP session', async () => {
    const client = await connect(reader.token)
    await database.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [reader.principal.id])
    const result = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('ACCESS_DENIED')
  })
})
