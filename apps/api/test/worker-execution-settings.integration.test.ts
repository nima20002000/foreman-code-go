import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { WorkerExecutionSettingsSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
const resources: Array<() => Promise<void>> = []
const retiredHttpPath = '/api/management/settings/worker-execution'
const startupCases = [
  { label: 'absent', environment: {}, enabled: false },
  { label: 'zero', environment: { FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0' }, enabled: false },
  { label: 'one', environment: { FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '1' }, enabled: true },
]

beforeAll(async () => {
  database = await currentDatabase()
}, 60_000)

afterAll(async () => {
  await database.close()
}, 60_000)

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})

async function settingsApp(environment: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, ...environment })
  const access = new PostgresAccessService(database.pool)
  const workerExecution = new WorkerExecutionPolicy(config.workerExecution)
  const services = {
    workerExecution,
    commands: new PostgresCommandCoordinator(database.pool),
  } as unknown as OperatorServices
  const app = buildApp({
    logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  resources.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issue = (name: string, grants: ManagementGrant[]) => access.issue({
    name,
    audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000),
    grants,
  })
  const connect = async (token: string) => {
    const client = new Client({ name: 'Worker settings test', version: '1' })
    resources.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  return { app, access, issue, connect }
}

it.each(startupCases)(
  'reads startup status with the environment setting $label through authenticated MCP only',
  async ({ environment, enabled }) => {
    const { app, access, issue, connect } = await settingsApp(environment)
    const grants: ManagementGrant[] = [{ actions: ['settings:read', 'capabilities:read'], scope: {} }]
    const reader = await issue('Settings reader', grants)
    const expected = { enabled, managedBy: 'startup' }
    // The web app shows this on the Main computer card from build status; the HTTP read is retired.
    expect((await app.inject({ method: 'GET', url: retiredHttpPath, headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(404)

    const client = await connect(reader.token)
    const tools = (await client.listTools()).tools
    const tool = tools.find(value => value.name === 'worker_execution_settings_get')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.description).toContain('global settings:read')
    expect(tool?.description).toContain('controlled at startup by a person; MCP cannot change it')
    const readback = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(readback))).toEqual(expected)
    expect(tools.filter(value => value.name.startsWith('worker_execution_settings_')).map(value => value.name))
      .toEqual(['worker_execution_settings_get'])

    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({
      grants,
      tools: expect.arrayContaining(['worker_execution_settings_get']),
      requirements: expect.arrayContaining([{
        name: 'worker_execution_settings_get',
        actions: ['settings:read'],
        detail: expect.any(String),
      }]),
    })
    expect((await access.authenticate(reader.token)).grants).toEqual(grants)
  },
)

it.each(startupCases)(
  'retains startup status $label across sessions and rejects HTTP and MCP mutation',
  async ({ environment, enabled }) => {
    const { app, issue, connect } = await settingsApp(environment)
    const reader = await issue('Settings reader', [{ actions: ['settings:read'], scope: {} }])
    const expected = { enabled, managedBy: 'startup' }
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: retiredHttpPath,
        headers: { authorization: `Bearer ${reader.token}` },
        payload: { enabled: !enabled },
      })
      expect(response.statusCode).toBe(404)
    }
    const client = await connect(reader.token)
    await expect(client.callTool({
      name: 'worker_execution_settings_update',
      arguments: { enabled: !enabled },
    })).rejects.toThrow()
    const unchanged = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(unchanged))).toEqual(expected)

    const restarted = await settingsApp(environment)
    const persistedReader = await restarted.access.authenticate(reader.token)
    expect(persistedReader.id).toBe(reader.principal.id)
    expect(persistedReader.grants).toEqual(reader.principal.grants)
    const freshClient = await restarted.connect(reader.token)
    const readback = await freshClient.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(decodeMcpToolResult(readback))).toEqual(expected)
    const settings = await database.pool.query('select count(*)::int count from application_settings')
    expect(settings.rows[0].count).toBe(0)
  },
)

it.each(['0', '1'])(
  'denies missing MCP credentials, unrelated grants and workspace-scoped grants with startup status %s',
  async (enabled) => {
    const { app, issue, connect } = await settingsApp({ FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: enabled })
    const anonymousMcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(anonymousMcp.statusCode).toBe(401)
    const deniedGrants: ManagementGrant[][] = [
      [{ actions: ['harnesses:read', 'capabilities:read'], scope: {} }],
      [{ actions: ['settings:read', 'capabilities:read'], scope: { workspaceIds: [randomUUID()] } }],
    ]
    for (const grants of deniedGrants) {
      const denied = await issue('Denied settings reader', grants)
      const client = await connect(denied.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).not.toContain('worker_execution_settings_get')
      const refused = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
      expect(refused.isError).toBe(true)
      const body = refused.content.find((item) => item.type === 'text')
      expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
      expect(decodeMcpToolResult(capabilities)).toMatchObject({
        grants,
        tools: expect.not.arrayContaining(['worker_execution_settings_get']),
      })
    }
  },
)
