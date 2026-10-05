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
const settingsPath = '/api/management/settings/worker-execution'
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
  'reads startup status with the environment setting $label through HTTP and authenticated MCP',
  async ({ environment, enabled }) => {
    const { app, access, issue, connect } = await settingsApp(environment)
    const grants: ManagementGrant[] = [{ actions: ['settings:read', 'capabilities:read'], scope: {} }]
    const reader = await issue('Settings reader', grants)
    const expected = { enabled, managedBy: 'startup' }
    const response = await app.inject({
      method: 'GET',
      url: settingsPath,
      headers: { authorization: `Bearer ${reader.token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(WorkerExecutionSettingsSchema.parse(response.json())).toEqual(expected)

    const client = await connect(reader.token)
    const tools = (await client.listTools()).tools
    const tool = tools.find(value => value.name === 'worker_execution_settings_get')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.description).toContain('global settings:read')
    expect(tool?.description).toContain('controlled at startup by a person; MCP cannot change it')
    const readback = await client.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(readback.structuredContent)).toEqual(expected)
    expect(tools.filter(value => value.name.startsWith('worker_execution_settings_')).map(value => value.name))
      .toEqual(['worker_execution_settings_get'])

    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: {} })
    expect(capabilities.structuredContent).toMatchObject({
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
        url: settingsPath,
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
    expect(WorkerExecutionSettingsSchema.parse(unchanged.structuredContent)).toEqual(expected)

    const restarted = await settingsApp(environment)
    const persistedReader = await restarted.access.authenticate(reader.token)
    expect(persistedReader.id).toBe(reader.principal.id)
    expect(persistedReader.grants).toEqual(reader.principal.grants)
    const response = await restarted.app.inject({
      method: 'GET',
      url: settingsPath,
      headers: { authorization: `Bearer ${reader.token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(WorkerExecutionSettingsSchema.parse(response.json())).toEqual(expected)
    const freshClient = await restarted.connect(reader.token)
    const readback = await freshClient.callTool({ name: 'worker_execution_settings_get', arguments: {} })
    expect(WorkerExecutionSettingsSchema.parse(readback.structuredContent)).toEqual(expected)
    const settings = await database.pool.query('select count(*)::int count from application_settings')
    expect(settings.rows[0].count).toBe(0)
  },
)

it.each(['0', '1'])(
  'allows local reads and denies missing MCP credentials, unrelated grants and workspace-scoped grants with startup status %s',
  async (enabled) => {
    const { app, issue, connect } = await settingsApp({ FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: enabled })
    const local = await app.inject({ method: 'GET', url: settingsPath })
    expect(local.statusCode).toBe(200)
    expect(WorkerExecutionSettingsSchema.parse(local.json()).enabled).toBe(enabled === '1')
    expect((await app.inject({ method: 'GET', url: settingsPath, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)
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
      const response = await app.inject({
        method: 'GET',
        url: settingsPath,
        headers: { authorization: `Bearer ${denied.token}` },
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const client = await connect(denied.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).not.toContain('worker_execution_settings_get')
      await expect(client.callTool({ name: 'worker_execution_settings_get', arguments: {} })).rejects.toThrow()
      const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: {} })
      expect(capabilities.structuredContent).toMatchObject({
        grants,
        tools: expect.not.arrayContaining(['worker_execution_settings_get']),
      })
    }
  },
)
