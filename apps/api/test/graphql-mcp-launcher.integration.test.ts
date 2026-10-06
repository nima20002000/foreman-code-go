import { removeFixtureDirectory } from './helpers/testResources.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN', 'both'])('routes %s for simultaneous instances and changed ports through authenticated MCP, preserving grants and durable writes', async (tokenVariable) => {
  const database = createDatabase({ connectionString: process.env.TEST_DATABASE_URL!,
    maxConnections: 4, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
  cleanup.push(() => database.close())
  await database.migrate()
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(database.pool), commands)
  const services = { settings, commands } as OperatorServices
  const directory = await mkdtemp(join(tmpdir(), 'operator-routing-'))
  cleanup.push(() => removeFixtureDirectory(directory))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const issue = async (writable: boolean) => access.issue({ name: 'launcher-test', audience: 'operator',
    grants: [{ actions: writable ? ['settings:read', 'settings:update'] : ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
  const owner = await issue(true)
  const reader = await issue(false)
  cleanup.push(async () => {
    for (const principal of [owner.principal, reader.principal]) {
      await database.pool.query('delete from management_audit where principal_id=$1', [principal.id])
      await database.pool.query('delete from management_command_receipts where principal_id=$1', [principal.id])
      await database.pool.query('delete from management_principals where id=$1', [principal.id])
    }
  })
  const start = async () => {
    const app = buildApp({ readiness: { database, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    let requests = 0
    app.addHook('onRequest', async () => { requests++ })
    const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    cleanup.push(() => app.close())
    return { app, endpoint, requests: () => requests }
  }
  const first = await start()
  const second = await start()
  expect(first.endpoint).not.toBe(second.endpoint)
  let removeOwner = await registerAppRoute(owner.token, first.endpoint, owner.principal.expiresAt, launcher)
  cleanup.push(() => removeOwner())
  const removeReader = await registerAppRoute(reader.token, second.endpoint, reader.principal.expiresAt, launcher)
  cleanup.push(removeReader)
  const connect = async (token: string) => {
    const client = new Client({ name: 'launcher-integration', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], env: tokenVariable === 'both' ? { GRAPHQL_MCP_TOKEN: token, FOREMAN_CODE_MCP_TOKEN: token } : { [tokenVariable]: token }, stderr: 'pipe' }))
    return client
  }
  const ownerClient = await connect(owner.token)
  expect(first.requests()).toBeGreaterThan(0)
  expect(second.requests()).toBe(0)
  const readerClient = await connect(reader.token)
  expect(second.requests()).toBeGreaterThan(0)
  const initial = (await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent as { revision: number; value: Record<string, unknown> }
  const value = { ...initial.value, description: `automatic routing ${randomUUID()}` }
  const saved = await ownerClient.callTool({ name: 'workspace_defaults_update', arguments: { commandId: randomUUID(), expectedRevision: initial.revision, value } })
  expect(saved.isError).not.toBe(true)
  const readback = await readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })
  expect(readback.structuredContent).toMatchObject({ value })
  expect(await settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
  const deniedUpdate = await readerClient.callTool({ name: 'workspace_defaults_update', arguments: {
    commandId: randomUUID(), expectedRevision: initial.revision + 1, value: initial.value,
  } })
  expect(deniedUpdate.isError).toBe(true)
  expect(JSON.stringify(deniedUpdate.content)).toContain('ACCESS_DENIED')
  // The SAME launcher and client follow a refreshed owner route after a port change.
  await first.app.close()
  await removeOwner()
  removeOwner = await registerAppRoute(owner.token, second.endpoint, owner.principal.expiresAt, launcher)
  expect((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent).toMatchObject({ value })
  for (const file of await readdir(join(directory, 'routes'))) {
    const text = await readFile(join(directory, 'routes', file), 'utf8')
    expect(text).not.toContain(owner.token)
    expect(text).not.toContain(reader.token)
  }
  await access.revoke(reader.principal.id)
  await expect(readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).rejects.toThrow('authentication expired or was revoked')
  await removeOwner()
  await expect(ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).rejects.toThrow('route is unavailable')
  await removeReader()
  const restarted = new AppMcpRoutes(database.pool, second.endpoint, launcher)
  cleanup.push(() => restarted.close())
  await restarted.refresh()
  expect((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} })).structuredContent).toMatchObject({ value })
  await access.revoke(owner.principal.id)
  await restarted.refresh()
  const remaining = await readdir(join(directory, 'routes'))
  // Other integration fixtures may leave active root credentials in this DB.
  for (const token of [owner.token, reader.token]) expect(remaining).not.toContain(`${createHash('sha256').update(token).digest('hex')}.json`)
}, 30_000)

it('refuses conflicting launcher token aliases without exposing either credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launcher-conflict-'))
  cleanup.push(() => removeFixtureDirectory(directory))
  const launcher = join(directory, 'launcher.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const client = new Client({ name: 'launcher-conflict', version: '1' })
  cleanup.push(() => client.close())
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher],
    env: { GRAPHQL_MCP_TOKEN: 'old-private-token', FOREMAN_CODE_MCP_TOKEN: 'new-private-token' }, stderr: 'pipe' })
  let failure: unknown
  try { await client.connect(transport) } catch (error) { failure = error }
  expect(String(failure)).toContain('FOREMAN_CODE_MCP_TOKEN conflicts with GRAPHQL_MCP_TOKEN')
  expect(String(failure)).not.toContain('old-private-token')
  expect(String(failure)).not.toContain('new-private-token')
})
