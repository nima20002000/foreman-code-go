import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunHistoryResponseSchema, RUN_HISTORY_MCP_TOOL } from '@graphql/contracts/run-history'
import type { ManagementAction, ManagementScope } from '@graphql/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

/** Real loopback HTTP and Streamable MCP, persisted principals and an isolated schema. */
describe.skipIf(!postgresEnabled)('historical Run HTTP/MCP parity', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>
  let access: PostgresAccessService
  let address: string
  let scope: { workspaceId: string; workflowId: string; runId: string; workflowVersionId: string; executionSemanticsVersion: 1 }
  let grantedToken: string, runsOnlyToken: string, deniedToken: string
  const clients: Client[] = []

  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    const f = await seedAgent3(db.pool, db.directory, undefined, { legacy: true, run: false })
    scope = { ...f.scope, executionSemanticsVersion: 1 }
    const { executionSemanticsVersion, ...legacyRun } = f.run
    void executionSemanticsVersion
    const run = { ...legacyRun, executionState: 'completed', outcome: 'succeeded',
      result: { outcome: 'succeeded', output: { text: 'OLD-RUN-RESULT' } }, finishedAt: f.createdAt }
    await db.pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values($1,$2,$3,$4,'completed',$5::jsonb)`,
    [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId, JSON.stringify(run)])
    const issue = async (actions: Array<{ actions: ManagementAction[]; scope: ManagementScope }>) =>
      (await access.issue({ name: 'Historical Run reader', audience: 'operator', grants: actions,
        expiresAt: new Date(Date.now() + 300_000) })).token
    const runGrant: { actions: ManagementAction[]; scope: ManagementScope } = { actions: ['runs:read'], scope: { workspaceIds: [scope.workspaceId],
      workflowIds: [scope.workflowId], runIds: [scope.runId] } }
    grantedToken = await issue([runGrant, { actions: ['agents:read'], scope: { workspaceIds: [scope.workspaceId] } }])
    runsOnlyToken = await issue([runGrant])
    deniedToken = await issue([{ ...runGrant, scope: { ...runGrant.scope, runIds: ['different-run'] } }])
    const commands = new PostgresCommandCoordinator(db.pool)
    const runs = new RunManagementService(db.pool, commands, {} as ConstructorParameters<typeof RunManagementService>[2],
      {} as ConstructorParameters<typeof RunManagementService>[3], {} as ConstructorParameters<typeof RunManagementService>[4])
    const services = { runs, commands } as unknown as OperatorServices
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close()
    await db?.close()
  })
  const path = () => `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/historical?${new URLSearchParams({
    workflowId: scope.workflowId, workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: '1',
  })}`
  async function connect(token: string) {
    const client = new Client({ name: 'run-history-parity', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address),
      { authProvider: { token: async () => token } }))
    clients.push(client)
    return client
  }

  it('reads the same saved pins through authenticated HTTP and MCP and gates Agent settings', async () => {
    const http = await app.inject({ method: 'GET', url: path(),
      headers: { host: 'localhost', authorization: `Bearer ${grantedToken}` } })
    expect(http.statusCode).toBe(200)
    const full = RunHistoryResponseSchema.parse(http.json())
    expect(full.nodes).toHaveLength(2)
    expect(full.agentConfigurations).toHaveLength(2)
    expect(full.runResult?.outputPreview).toBe('OLD-RUN-RESULT')
    const client = await connect(grantedToken)
    expect((await client.listTools()).tools.some((tool) => tool.name === RUN_HISTORY_MCP_TOOL)).toBe(true)
    const mcp = await client.callTool({ name: RUN_HISTORY_MCP_TOOL, arguments: scope })
    expect(mcp.isError).not.toBe(true)
    expect(RunHistoryResponseSchema.parse(mcp.structuredContent)).toEqual(full)
    const limited = await app.inject({ method: 'GET', url: path(),
      headers: { host: 'localhost', authorization: `Bearer ${runsOnlyToken}` } })
    expect(limited.statusCode).toBe(200)
    expect(RunHistoryResponseSchema.parse(limited.json()).agentConfigurations).toEqual([])
    const limitedMcp = await (await connect(runsOnlyToken)).callTool({ name: RUN_HISTORY_MCP_TOOL, arguments: scope })
    expect(RunHistoryResponseSchema.parse(limitedMcp.structuredContent).agentConfigurations).toEqual([])
    expect(JSON.stringify(full)).not.toMatch(/initialPrompt|assignedSkills|resolvedSkills|prompt|advanced/i)
  })
  it('rejects another Run scope through both transports before historical data is read', async () => {
    const http = await app.inject({ method: 'GET', url: path(),
      headers: { host: 'localhost', authorization: `Bearer ${deniedToken}` } })
    expect(http.statusCode).toBe(403)
    const client = await connect(deniedToken)
    const result = await client.callTool({ name: RUN_HISTORY_MCP_TOOL, arguments: scope }).catch((error: unknown) => ({ isError: true, error }))
    expect(result.isError).toBe(true)
  })
})
