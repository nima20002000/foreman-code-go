import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  BugReportCreateResultSchema,
  BugReportPageSchema,
  BugReportSchema,
  BugReportUpdateResultSchema,
  type ManagementAction,
} from '@foreman-code/contracts/management'
import { decodeMcpToolResult, OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'

async function fixture(options: { agentOnly?: boolean } = {}) {
  const saved = makeCurrentWorkflowFixture(randomUUID())
  saved.configurations = saved.configurations.map(configuration => ({
    ...configuration,
    graphqlTools: ['context_get' as const],
  }))
  saved.version.definition.nodes = saved.version.definition.nodes.map(node => ({
    ...node,
    graphqlTools: { add: [], remove: ['bug_report' as const] },
  }))
  const runtime = await codexApprovalRuntime('user', { fixture: saved })
  const clients: Client[] = []
  const commands = new PostgresCommandCoordinator(runtime.db.pool)
  const bugs = new BugReportService(runtime.db.pool, commands)
  const services = { commands, bugReports: bugs } as unknown as OperatorServices
  const app = buildApp({
    logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    ...(options.agentOnly ? {} : { operator: { access: runtime.access, services } }),
    appMcp: {
      access: runtime.access,
      commands,
      interactions: new PostgresAppInteractionService(runtime.db.pool, runtime.repository, commands),
      bugReports: bugs,
    },
  })
  try {
    await runtime.engine.start(runtime.f.run.id)
    const [interaction] = await runtime.pending()
    if (!interaction) throw new Error('Expected an active Agent awaiting approval')
    const credential = await runtime.credentials.issueForExecution(interaction.executionId)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'bug-reports-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    async function operator(actions: ManagementAction[], workspaceId = runtime.f.scope.workspaceId) {
      const issued = await runtime.access.issue({
        name: 'Bug report Operator', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions, scope: { workspaceIds: [workspaceId] } }],
      })
      return { ...issued, client: await connect(issued.token) }
    }
    return {
      ...runtime,
      app,
      bugs,
      services,
      commands,
      credential,
      executionId: interaction.executionId,
      operator,
      connect,
      worker: await connect(credential.environment.variables.GRAPHQL_MCP_TOKEN!),
      async close() {
        await Promise.all(clients.map(client => client.close()))
        await app.close()
        await runtime.close()
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await runtime.close()
    throw error
  }
}

const reportInput = () => ({
  commandId: randomUUID(), title: 'Workflow tool failed',
  tried: { feature: 'context_get', inputsSummary: 'Read the active Agent context' },
  happened: { errorCode: 'CONTEXT_UNAVAILABLE', message: 'Context could not be read' },
  expected: 'Read the context and available tools', severity: 'high' as const,
})

function value(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).not.toBe(true)
  return decodeMcpToolResult(result)
}

it('reports from a scoped Agent and lets Operator discover, read and triage persisted reports with safe retries', async () => {
  const f = await fixture()
  try {
    const names = (await f.worker.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('bug_report')
    expect(names).not.toContain('bug_reports_list')
    expect(names).not.toContain('bug_report_update')
    expect(names).not.toContain('interaction_list')
    const context = value(await f.worker.callTool({ name: 'context_get', arguments: {} }))
    expect(context).toMatchObject({ capabilities: { bugReport: true } })
    const scope = { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id] }
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [f.credential.principalId, JSON.stringify([{ actions: ['bug_reports:report'], scope }])])
    expect(value(await f.worker.callTool({ name: 'context_get', arguments: {} })))
      .toMatchObject({ capabilities: { bugReport: true, interactionList: false, interactionGet: false } })
    const input = reportInput()
    const first = BugReportCreateResultSchema.parse(value(await f.worker.callTool({ name: 'bug_report', arguments: input })))
    expect(first).toMatchObject({ deduplicated: false, replayed: false, report: {
      workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, runId: f.f.run.id,
      harness: 'codex', reporter: { principalId: f.credential.principalId, audience: 'worker' },
      status: 'open', revision: 1, occurrenceCount: 1,
    } })
    expect(BugReportCreateResultSchema.parse(value(await f.worker.callTool({ name: 'bug_report', arguments: input }))))
      .toEqual({ ...first, replayed: true })
    const repeat = BugReportCreateResultSchema.parse(value(await f.worker.callTool({ name: 'bug_report',
      arguments: { ...input, commandId: randomUUID() } })))
    expect(repeat).toMatchObject({ deduplicated: true, report: { id: first.report.id, occurrenceCount: 2 } })
    const renewed = await f.credentials.issueForExecution(f.executionId)
    expect(renewed.principalId).not.toBe(f.credential.principalId)
    const renewedAgent = await f.connect(renewed.environment.variables.GRAPHQL_MCP_TOKEN!)
    const renewedRepeat = BugReportCreateResultSchema.parse(value(await renewedAgent.callTool({ name: 'bug_report',
      arguments: { ...input, commandId: randomUUID() } })))
    expect(renewedRepeat).toMatchObject({ deduplicated: true, report: { id: first.report.id, occurrenceCount: 3 } })
    const writer = await f.operator(['bug_reports:report', 'bug_reports:read', 'bug_reports:update', 'capabilities:read'])
    expect((await writer.client.listTools()).tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining(['bug_report', 'bug_reports_list', 'bug_report_get', 'bug_report_update']))
    const capabilities = value(await writer.client.callTool({ name: 'operator_get_capabilities',
      arguments: { workspaceId: f.f.scope.workspaceId, detail: 'full' } }))
    expect(capabilities).toMatchObject({ tools: expect.arrayContaining(['bug_report', 'bug_reports_list',
      'bug_report_get', 'bug_report_update']) })
    const schema = OperatorToolSchemaResultSchema.parse(value(await writer.client.callTool({
      name: 'operator_tool_schema_get', arguments: { name: 'bug_report_update', includeOutputSchema: true },
    })))
    expect(schema.permissionRequirements.actions).toEqual(['bug_reports:update'])
    expect(schema.inputSchema).toMatchObject({ properties: {
      commandId: expect.any(Object), expectedRevision: expect.any(Object),
      status: { enum: ['open', 'triaged', 'fixed', 'wont-fix'] },
    } })
    expect(schema.outputSchema).toBeDefined()
    const read = BugReportSchema.parse(value(await writer.client.callTool({ name: 'bug_report_get',
      arguments: { reportId: first.report.id } })))
    expect(read).toEqual(renewedRepeat.report)
    const update = { reportId: read.id, commandId: randomUUID(), expectedRevision: read.revision, status: 'triaged' }
    const updated = BugReportUpdateResultSchema.parse(value(await writer.client.callTool({ name: 'bug_report_update',
      arguments: update })))
    expect(updated.report).toMatchObject({ status: 'triaged', revision: read.revision + 1 })
    f.services.bugReports = new BugReportService(f.db.pool, f.commands)
    expect(BugReportUpdateResultSchema.parse(value(await writer.client.callTool({ name: 'bug_report_update',
      arguments: update })))).toEqual({ ...updated, replayed: true })
    expect((await writer.client.callTool({ name: 'bug_report_update',
      arguments: { ...update, commandId: randomUUID() } })).isError).toBe(true)
    const listed = BugReportPageSchema.parse(value(await writer.client.callTool({ name: 'bug_reports_list',
      arguments: { status: 'triaged', severity: 'high' } })))
    expect(listed.items).toEqual([updated.report])
    const reader = await f.operator(['bug_reports:read'])
    const denied = await reader.client.callTool({ name: 'bug_report_update', arguments: {
      ...update, commandId: randomUUID(), expectedRevision: updated.report.revision, status: 'fixed',
    } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(value(await reader.client.callTool({ name: 'bug_report_get', arguments: { reportId: read.id } })))
      .toEqual(updated.report)
    const audit = await f.db.pool.query('select action,outcome from management_audit where principal_id=$1',
      [reader.principal.id])
    expect(audit.rows).toContainEqual({ action: 'bug_report_update', outcome: 'denied' })
  } finally { await f.close() }
}, 60_000)

it('keeps reporting within the live execution grant and denies worker management and foreign workspace reads', async () => {
  const f = await fixture()
  try {
    const writer = await f.operator(['bug_reports:report', 'bug_reports:read', 'bug_reports:update'])
    const created = BugReportCreateResultSchema.parse(value(await writer.client.callTool({ name: 'bug_report',
      arguments: reportInput() })))
    const foreign = await f.operator(['bug_reports:read'], 'other-workspace')
    expect((await foreign.client.callTool({ name: 'bug_report_get', arguments: { reportId: created.report.id } })).isError)
      .toBe(true)
    expect(BugReportPageSchema.parse(value(await foreign.client.callTool({ name: 'bug_reports_list', arguments: {} })))
      .items).toEqual([])
    const deniedManagement = await f.worker.callTool({ name: 'bug_report_get', arguments: { reportId: created.report.id } })
    expect(JSON.stringify(deniedManagement.content)).toContain('ROLE_NOT_ALLOWED')
    const spoofed = await f.worker.callTool({ name: 'bug_report', arguments: { ...reportInput(), runId: 'other-run' } })
    expect(JSON.stringify(spoofed.content)).toContain('ACCESS_DENIED')
    const wrongSchema = (await f.worker.listTools()).tools.find(tool => tool.name === 'bug_report')!.inputSchema
    expect(wrongSchema.properties).not.toHaveProperty('workspaceId')
    const input = reportInput()
    const accepted = BugReportCreateResultSchema.parse(value(await f.worker.callTool({ name: 'bug_report', arguments: input })))
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.credential.principalId,
      JSON.stringify([{ actions: ['interactions:read'], scope: {
        workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id],
      } }])])
    expect((await f.worker.listTools()).tools.map(tool => tool.name)).not.toContain('bug_report')
    const revoked = await f.worker.callTool({ name: 'bug_report', arguments: input })
    expect(JSON.stringify(revoked.content)).toContain('ACCESS_DENIED')
    expect(value(await writer.client.callTool({ name: 'bug_report_get', arguments: { reportId: accepted.report.id } })))
      .toEqual(accepted.report)
    const audits = await f.db.pool.query('select action,outcome from management_audit where principal_id=$1',
      [f.credential.principalId])
    expect(audits.rows).toContainEqual({ action: 'bug_report', outcome: 'denied' })
    await f.stop()
    const stopped = await f.app.inject({
      method: 'POST', url: '/mcp',
      headers: {
        authorization: `Bearer ${f.credential.environment.variables.GRAPHQL_MCP_TOKEN!}`,
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bug_report', arguments: input } },
    })
    expect(stopped.statusCode).toBe(401)
  } finally { await f.close() }
}, 60_000)

it('audits denied reporting through Agent MCP without requiring Operator services', async () => {
  const f = await fixture({ agentOnly: true })
  try {
    const accepted = BugReportCreateResultSchema.parse(value(await f.worker.callTool({
      name: 'bug_report', arguments: reportInput(),
    })))
    const scope = {
      workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id],
    }
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.credential.principalId,
      JSON.stringify([{ actions: ['interactions:read'], scope }])])
    const denied = await f.worker.callTool({ name: 'bug_report', arguments: reportInput() })
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const audit = await f.db.pool.query('select action,outcome from management_audit where principal_id=$1',
      [f.credential.principalId])
    expect(audit.rows).toContainEqual({ action: 'bug_report', outcome: 'denied' })
    const reader = await f.access.issue({
      name: 'Persisted bug reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['bug_reports:read'], scope: { workspaceIds: [f.f.scope.workspaceId] } }],
    })
    expect(await f.bugs.get(reader.principal, accepted.report.id)).toEqual(accepted.report)
  } finally { await f.close() }
}, 60_000)
