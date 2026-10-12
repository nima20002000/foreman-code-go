import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  BugReportCloseResultSchema,
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

it.each(['open', 'fixed', 'wont-fix', 'duplicate'] as const)(
  'returns only summary fields to other reporters when repeating a %s report, including retries', async status => {
    const f = await fixture()
    try {
      const owner = await f.operator(['bug_reports:report', 'bug_reports:read', 'bug_reports:update'])
      const input = reportInput()
      let saved = BugReportSchema.parse(BugReportCreateResultSchema.parse(value(await owner.client.callTool({
        name: 'bug_report', arguments: input,
      }))).report)
      if (status !== 'open') {
        const target = status === 'duplicate'
          ? BugReportCreateResultSchema.parse(value(await owner.client.callTool({
            name: 'bug_report', arguments: { ...reportInput(), title: 'Canonical failure' },
          }))).report
          : undefined
        const closed = BugReportCloseResultSchema.parse(value(await owner.client.callTool({
          name: 'bug_reports_close', arguments: {
            commandId: randomUUID(), status, note: 'Private resolution details',
            reports: [{ reportId: saved.id, expectedRevision: saved.revision }],
            ...(target ? { duplicateOfId: target.id } : {}),
          },
        })))
        saved = target ? BugReportSchema.parse(target) : closed.reports[0]!
      }
      const reporter = await f.operator(['bug_reports:report'])
      const summary = { id: saved.id, status: status === 'fixed' ? 'open' : saved.status, title: saved.title }
      for (const client of [f.worker, reporter.client]) {
        expect((await client.callTool({ name: 'bug_report_get', arguments: { reportId: saved.id } })).isError).toBe(true)
        const repeatInput = { ...input, commandId: randomUUID() }
        const repeat = BugReportCreateResultSchema.parse(value(await client.callTool({
          name: 'bug_report', arguments: repeatInput,
        })))
        expect(repeat.report).toEqual(summary)
        expect(repeat.deduplicated).toBe(true)
        expect(BugReportCreateResultSchema.parse(value(await client.callTool({
          name: 'bug_report', arguments: repeatInput,
        })))).toEqual({ ...repeat, replayed: true })
      }
      const readback = BugReportSchema.parse(value(await owner.client.callTool({
        name: 'bug_report_get', arguments: { reportId: saved.id },
      })))
      expect(readback).toMatchObject({ ...summary, occurrenceCount: saved.occurrenceCount + 2,
        tried: saved.tried, happened: saved.happened, expected: saved.expected, reporter: saved.reporter })
    } finally { await f.close() }
  }, 60_000,
)

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
    expect(renewedRepeat).toMatchObject({ deduplicated: true })
    expect(renewedRepeat.report).toEqual({ id: first.report.id, status: first.report.status, title: first.report.title })
    const writer = await f.operator(['bug_reports:report', 'bug_reports:read', 'bug_reports:update', 'capabilities:read'])
    expect((await writer.client.listTools()).tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining(['bug_report', 'bug_reports_list', 'bug_report_get', 'bug_report_update',
        'bug_reports_close']))
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
      status: { enum: ['open', 'triaged'] },
    } })
    expect(schema.outputSchema).toBeDefined()
    const read = BugReportSchema.parse(value(await writer.client.callTool({ name: 'bug_report_get',
      arguments: { reportId: first.report.id } })))
    expect(read).toEqual({ ...first.report, occurrenceCount: 3, revision: 3,
      lastReportedAt: expect.any(String), updatedAt: expect.any(String) })
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
      ...update, commandId: randomUUID(), expectedRevision: updated.report.revision, status: 'open',
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
    expect(accepted.report).toEqual({ id: created.report.id, status: created.report.status, title: created.report.title })
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.credential.principalId,
      JSON.stringify([{ actions: ['interactions:read'], scope: {
        workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id],
      } }])])
    expect((await f.worker.listTools()).tools.map(tool => tool.name)).not.toContain('bug_report')
    const revoked = await f.worker.callTool({ name: 'bug_report', arguments: input })
    expect(JSON.stringify(revoked.content)).toContain('ACCESS_DENIED')
    expect(value(await writer.client.callTool({ name: 'bug_report_get', arguments: { reportId: accepted.report.id } })))
      .toEqual({ ...created.report, occurrenceCount: 2, revision: 2,
        lastReportedAt: expect.any(String), updatedAt: expect.any(String) })
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

it('closes reports in batches into history, counts reworded repeats and reopens fixed regressions', async () => {
  const f = await fixture()
  try {
    const writer = await f.operator(['bug_reports:report', 'bug_reports:read', 'bug_reports:update'])
    const report = async (client: Client, input: Record<string, unknown>) =>
      BugReportCreateResultSchema.parse(value(await client.callTool({ name: 'bug_report', arguments: input })))
    const list = async (input: Record<string, unknown> = {}) =>
      BugReportPageSchema.parse(value(await writer.client.callTool({ name: 'bug_reports_list', arguments: input }))).items
    const first = await report(f.worker, reportInput())
    expect(first).toMatchObject({ outcome: 'created', deduplicated: false })
    const reworded = await report(f.worker, {
      ...reportInput(), title: '  workflow TOOL   failed ',
      tried: { feature: 'context_get', inputsSummary: 'Asked for the context in other words' },
      happened: { message: 'A differently worded failure' }, expected: 'Some other expectation',
    })
    expect(reworded).toMatchObject({ outcome: 'repeat', deduplicated: true,
      report: { id: first.report.id, status: 'open', occurrenceCount: 2 } })
    expect(reworded.message).toContain(first.report.id)
    expect(reworded.message).toContain('open')
    const second = await report(writer.client, { ...reportInput(), title: 'Board refresh is slow' })
    const third = await report(writer.client, { ...reportInput(), title: 'Run list misses filters' })
    expect(new Set((await list()).map(item => item.id)))
      .toEqual(new Set([first.report.id, second.report.id, third.report.id]))
    const revisions = new Map((await list()).map(item => [item.id, item.revision]))
    const close = {
      commandId: randomUUID(), status: 'fixed', note: 'Released in v1.2.3',
      reports: [first.report.id, second.report.id].map(reportId => ({ reportId, expectedRevision: revisions.get(reportId)! })),
    }
    const reader = await f.operator(['bug_reports:read'])
    const denied = await reader.client.callTool({ name: 'bug_reports_close', arguments: close })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(JSON.stringify((await f.worker.callTool({ name: 'bug_reports_close', arguments: close })).content))
      .toContain('ROLE_NOT_ALLOWED')
    expect((await list()).map(item => item.status)).toEqual(['open', 'open', 'open'])
    const audit = await f.db.pool.query('select action,outcome from management_audit where principal_id=$1',
      [reader.principal.id])
    expect(audit.rows).toContainEqual({ action: 'bug_reports_close', outcome: 'denied' })
    const closed = BugReportCloseResultSchema.parse(value(await writer.client.callTool({
      name: 'bug_reports_close', arguments: close,
    })))
    expect(closed.reports.map(item => [item.id, item.status]))
      .toEqual([[first.report.id, 'fixed'], [second.report.id, 'fixed']])
    expect(closed.reports[0]!.resolution)
      .toEqual({ status: 'fixed', note: 'Released in v1.2.3', closedAt: expect.any(String) })
    expect(BugReportCloseResultSchema.parse(value(await writer.client.callTool({ name: 'bug_reports_close',
      arguments: close })))).toEqual({ ...closed, replayed: true })
    const stale = await writer.client.callTool({ name: 'bug_reports_close', arguments: {
      commandId: randomUUID(), status: 'wont-fix', reports: [{ reportId: third.report.id, expectedRevision: 9 }],
    } })
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
    const missingTarget = await writer.client.callTool({ name: 'bug_reports_close', arguments: {
      commandId: randomUUID(), status: 'duplicate', reports: [{ reportId: third.report.id, expectedRevision: 1 }],
    } })
    expect(JSON.stringify(missingTarget.content)).toContain('INVALID_INPUT')
    const duplicate = BugReportCloseResultSchema.parse(value(await writer.client.callTool({ name: 'bug_reports_close',
      arguments: { commandId: randomUUID(), status: 'duplicate', duplicateOfId: first.report.id,
        reports: [{ reportId: third.report.id, expectedRevision: 1 }] } })))
    expect(duplicate.reports[0]).toMatchObject({ status: 'duplicate', resolution: { duplicateOfId: first.report.id } })
    expect(await list()).toEqual([])
    const history = await list({ view: 'history' })
    expect(history.map(item => [item.id, item.status])).toEqual([
      [third.report.id, 'duplicate'], [second.report.id, 'fixed'], [first.report.id, 'fixed'],
    ])
    expect(history[1]).toEqual(closed.reports[1])
    expect((await list({ view: 'history', status: 'duplicate' })).map(item => item.id)).toEqual([third.report.id])
    const regression = await report(f.worker, reportInput())
    expect(regression).toMatchObject({ outcome: 'reopened', deduplicated: true, report: {
      id: first.report.id, status: 'open', occurrenceCount: 3, resolution: { status: 'fixed', note: 'Released in v1.2.3' },
    } })
    expect(regression.message).toContain('regression')
    const viaDuplicate = await report(writer.client, { ...reportInput(), title: 'Run list misses filters' })
    expect(viaDuplicate).toMatchObject({ outcome: 'repeat' })
    expect(viaDuplicate.report).toEqual({ id: first.report.id, status: 'open', title: first.report.title })
    expect((await list()).map(item => item.id)).toEqual([first.report.id])
    expect(value(await writer.client.callTool({ name: 'bug_report_get', arguments: { reportId: first.report.id } })))
      .toEqual({ ...regression.report, occurrenceCount: 4, revision: 5,
        lastReportedAt: expect.any(String), updatedAt: expect.any(String) })
  } finally { await f.close() }
}, 60_000)
