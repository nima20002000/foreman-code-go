import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { installManagedLauncher, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { upgradeProductionMcpLauncher } from '../src/modules/harnesses/productionMcpUpgrade.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  try {
    while (cleanup.length) await cleanup.pop()!()
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(['codex', 'opencode'] as const)(
  'upgrades the saved %s launcher through authenticated MCP and two API restarts', async harness => {
    const home = await mkdtemp(join(tmpdir(), 'production-mcp-restart-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const previous = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
    const shared = join(home, '.local/share/graphql/mcp/launcher.mjs')
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(previous))
    await installManagedLauncher(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), previous)
    const tokenVariable = harness === 'codex' ? 'GRAPHQL_MCP_TOKEN' : 'FOREMAN_CODE_MCP_TOKEN'
    const connection = {
      transport: 'stdio' as const, executable: process.execPath, arguments: [previous],
      environmentVariables: [tokenVariable],
    }
    const entry = nativeConnection(harness, connection)
    expect(isAppLauncher(harness, entry)).toBe(true)
    const database = createDatabase({
      connectionString: process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      maxConnections: 4, connectionTimeoutMs: 5000, queryTimeoutMs: 5000,
    })
    cleanup.push(() => database.close())
    await database.migrate()
    const access = new PostgresAccessService(database.pool)
    const issue = (role: 'owner' | 'reader') => access.issue({
      name: 'production-upgrade', audience: 'operator',
      grants: [{ actions: role === 'owner' ? ['settings:read', 'settings:update'] : ['settings:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000),
    })
    const owner = await issue('owner')
    const reader = await issue('reader')
    cleanup.push(async () => {
      for (const { principal } of [owner, reader]) {
        await database.pool.query('delete from management_audit where principal_id=$1', [principal.id])
        await database.pool.query('delete from management_command_receipts where principal_id=$1', [principal.id])
        await database.pool.query('delete from management_principals where id=$1', [principal.id])
      }
    })
    const start = async () => {
      const commands = new PostgresCommandCoordinator(database.pool)
      const settings = new FoundationSettingsManagementService(
        new PostgresFoundationSettingsRepository(database.pool), commands,
      )
      const app = buildApp({
        readiness: { database, checkpoints: { ping: async () => undefined } },
        operator: { access: new PostgresAccessService(database.pool), services: { settings, commands } as OperatorServices },
      })
      let requests = 0
      app.addHook('onRequest', async () => { requests += 1 })
      const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
      const routes = new AppMcpRoutes(database.pool, endpoint)
      const close = async () => {
        await routes.close()
        await app.close()
      }
      cleanup.push(close)
      await routes.refresh()
      return { close, routes, settings, requests: () => requests }
    }
    const connect = async (token: string) => {
      const client = new Client({ name: 'production-upgrade', version: '1' })
      cleanup.push(() => client.close())
      const command = harness === 'codex'
        ? [entry.command as string, ...(entry.args as string[])] : entry.command as string[]
      await client.connect(new StdioClientTransport({
        command: command[0]!, args: command.slice(1), env: { [tokenVariable]: token }, stderr: 'pipe',
      }))
      return client
    }
    const first = await start()
    const ownerClient = await connect(owner.token)
    const readerClient = await connect(reader.token)
    const initial = (await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))
      .structuredContent as { revision: number; value: Record<string, unknown> }
    const value = { ...initial.value, description: `production upgrade ${randomUUID()}` }
    const saved = await ownerClient.callTool({ name: 'workspace_defaults_update', arguments: {
      commandId: randomUUID(), expectedRevision: initial.revision, value,
    } })
    expect(saved.isError).not.toBe(true)
    const assertReadback = async (settings: FoundationSettingsManagementService) => {
      expect((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent)
        .toMatchObject({ value })
      expect((await readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent)
        .toMatchObject({ value })
      await expect(readerClient.callTool({ name: 'workspace_defaults_update', arguments: {
        commandId: randomUUID(), expectedRevision: initial.revision + 1, value: initial.value,
      } })).rejects.toThrow('not found')
      expect(await settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
    }
    await assertReadback(first.settings)
    await first.close()
    const runtimeModule = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
    const { localProductionEnvironment } = await import(runtimeModule)
    const environment = localProductionEnvironment(home, 'a'.repeat(64))
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', environment.FOREMAN_CODE_APP_MCP_DIRECTORY)
    expect(isAppLauncher(harness, entry)).toBe(false)
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(harness, entry)).toBe(true)
    const upgraded = await start()
    await assertReadback(upgraded.settings)
    expect(upgraded.requests()).toBeGreaterThan(0)
    const renewedOwnerClient = await connect(owner.token)
    expect((await renewedOwnerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent)
      .toMatchObject({ value })
    await upgraded.close()
    await upgradeProductionMcpLauncher(home)
    await installManagedLauncher(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), shared)
    const restarted = await start()
    await assertReadback(restarted.settings)
    expect(restarted.requests()).toBeGreaterThan(0)
    expect(isAppLauncher(harness, entry)).toBe(true)
    const digest = createHash('sha256').update(owner.token).digest('hex')
    const route = await readFile(join(dirname(previous), 'routes', `${digest}.json`), 'utf8')
    expect(route).not.toContain(owner.token)
    expect(route).not.toContain(reader.token)
    await access.revoke(reader.principal.id)
    await restarted.routes.refresh()
    await expect(readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))
      .rejects.toThrow('route is unavailable')
    expect(await restarted.settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
  }, 30_000,
)
