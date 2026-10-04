import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { CodexPluginDetailResultSchema, CodexPluginListResultSchema, type CodexPluginSummary } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CodexPluginSettingsService } from '../src/modules/harnesses/codexPluginSettings.js'
import { normalizeCodexPluginCatalog } from '../src/modules/harnesses/codexPluginCatalog.js'
import type { CodexPluginAdapter } from '../src/modules/harnesses/codexPlugins.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const connectionString = process.env.TEST_DATABASE_URL!
const admin = new pg.Pool({ connectionString })
const schema = `codex_plugins_${randomUUID().replaceAll('-', '')}`
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
beforeAll(async () => {
  await createFixtureSchema(admin, schema)
  await applyApplicationMigrations(pool)
}, 60_000)
afterAll(async () => {
  await pool.end()
  try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
}, 60_000)
const clients: Client[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.close() })

it('lists and reads Codex plugins through authenticated MCP while browser-only changes retain native readback', async () => {
  const item: CodexPluginSummary = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1.0.0',
    installed: false, enabled: false, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL' }
  let installed = false
  let changes = 0
  let failChange = false
  const nativeMcp = { linear: { url: 'https://mcp.linear.app/mcp/readonly' } }
  const home = await mkdtemp(join(tmpdir(), 'plugin-settings-test-'))
  const file = join(home, 'config.toml'); await writeFile(file, '')
  const adapter: CodexPluginAdapter = {
    recoveryIdentity: 'integration-writer',
    list: async () => normalizeCodexPluginCatalog({ installed: installed ? [{ ...item, installed: true, enabled: true, source: { source: 'remote', id: 'notes' } }] : [],
      available: installed ? [] : [{ ...item, source: { source: 'remote', id: 'notes' } }] },
      { file, userConfig: { mcp_servers: nativeMcp, plugins: installed ? { [item.pluginId]: { enabled: true } } : {} } }, 'complete'),
    detail: async (plugin) => plugin.installed ? { status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes'], apps: [] } : { status: 'unknown' },
    change: async (_id, action) => { changes++; if (failChange) throw new Error('native response unavailable'); installed = action === 'install'; return { acknowledged: true, version: installed ? '1.0.0' : null } },
  }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const plugins = new CodexPluginSettingsService(pool, adapter)
  const services = { commands, harnessSettings: { plugins, mcp: {}, directories: {} } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    const owner = await access.issue({ name: 'Plugin owner', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const delegated = await access.issue({ name: 'Plugin requester', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const reader = await access.issue({ name: 'Plugin reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const denied = await access.issue({ name: 'Denied', audience: 'operator', grants: [{ actions: ['capabilities:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'plugin-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const allowed = await connect(reader.token)
    const disallowed = await connect(denied.token)
    expect((await disallowed.listTools()).tools.map((tool) => tool.name)).not.toContain('codex_plugins_list')
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).toContain('codex_plugins_list')
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).not.toContain('codex_plugin_install')
    const list = async (view: 'installed' | 'available') => CodexPluginListResultSchema.parse(
      (await allowed.callTool({ name: 'codex_plugins_list', arguments: { view } })).structuredContent)
    expect((await list('available')).items.map((plugin) => plugin.pluginId)).toEqual(['notes@trusted'])
    expect(CodexPluginDetailResultSchema.parse((await allowed.callTool({ name: 'codex_plugin_get',
      arguments: { pluginId: item.pluginId } })).structuredContent).contents).toEqual({ status: 'unknown' })
    const before = await list('available')
    const input = { pluginId: item.pluginId, action: 'install' as const, expectedRevision: before.revision, artifactIdentity: (await plugins.get(owner.principal, item.pluginId)).artifactIdentity, commandId: randomUUID() }
    expect((await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/plugins/change',
      headers: { authorization: `Bearer ${owner.token}` }, payload: input })).statusCode).toBe(403)
    await expect(plugins.change(delegated.principal, input)).rejects.toMatchObject({ code: 'CODEX_PLUGIN_BROWSER_REQUIRED', status: 403 })
    expect((await plugins.change(owner.principal, input)).status).toBe('applied')
    expect((await plugins.change(owner.principal, input)).status).toBe('applied')
    expect(changes).toBe(1)
    expect((await list('installed')).items).toMatchObject([{ pluginId: item.pluginId, installed: true }])
    expect(CodexPluginDetailResultSchema.parse((await allowed.callTool({ name: 'codex_plugin_get',
      arguments: { pluginId: item.pluginId } })).structuredContent).contents).toEqual({ status: 'known', skills: ['summarize'], hooks: [], mcpServers: ['notes'], apps: [] })
    const removal = { pluginId: item.pluginId, action: 'remove' as const, expectedRevision: (await list('installed')).revision, artifactIdentity: (await plugins.get(owner.principal, item.pluginId)).artifactIdentity, commandId: randomUUID() }
    expect((await plugins.change(owner.principal, removal)).status).toBe('applied')
    expect((await list('available')).items).toHaveLength(1)
    expect(nativeMcp.linear.url).toBe('https://mcp.linear.app/mcp/readonly')
    failChange = true
    const uncertainInput = { ...input, expectedRevision: (await list('available')).revision, commandId: randomUUID() }
    expect((await plugins.change(owner.principal, uncertainInput)).status).toBe('uncertain')
    expect((await plugins.change(owner.principal, uncertainInput)).status).toBe('uncertain')
    expect(changes).toBe(3)
  } finally {
    await plugins.shutdown(); await app.close(); await removeFixtureDirectory(home)
  }
})
