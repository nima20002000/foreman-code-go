import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { HarnessOptionsResultSchema } from '@graphql/contracts/management'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('refreshes and reads back model options through authenticated HTTP and Operator MCP', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
  const schema = 'model_refresh_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  const directory = await mkdtemp(join(tmpdir(), 'graphql-model-mcp-'))
  const cache = join(directory, 'catalog.json')
  await writeFile(cache, JSON.stringify(['provider/old-model']))
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const access = new PostgresAccessService(pool)
  const clients: Client[] = []
  const modelOptions = async () => HarnessOptionsResultSchema.parse({
    harness: 'opencode', providerVersion: '1.18.31', authenticated: true,
    models: (JSON.parse(await readFile(cache, 'utf8')) as string[]).map((id) => ({
      id, name: id, reasoningEfforts: [], variants: [''], serviceTiers: [],
    })), nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  const native = {
    options: vi.fn(modelOptions),
    refreshOptions: vi.fn(async (_harness: string, refresh: string) => {
      if (refresh === 'upstream') await writeFile(cache, JSON.stringify(['provider/new-model']))
      return modelOptions()
    }),
  }
  const invalidateChecks = vi.fn()
  const services = { commands: new PostgresCommandCoordinator(pool), harnesses: { invalidateChecks },
    extensions: { native } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const readerGrant = await access.issue({ name: 'Model catalog reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const updaterGrant = await access.issue({ name: 'Model catalog updater', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const denied = await access.issue({ name: 'No harness grant', audience: 'operator',
      grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'model-refresh-test', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
      return client
    }
    const reader = await connect(readerGrant.token)
    const updater = await connect(updaterGrant.token)
    const restricted = await connect(denied.token)
    const readerTools = (await reader.listTools()).tools
    expect(readerTools.map((tool) => tool.name)).toContain('harness_options_refresh')
    expect(readerTools.map((tool) => tool.name)).not.toContain('opencode_models_cache_update')
    expect(readerTools.find((tool) => tool.name === 'harness_options_refresh')?.annotations?.readOnlyHint).toBe(true)
    expect((await updater.listTools()).tools.find((tool) => tool.name === 'opencode_models_cache_update')?.annotations?.readOnlyHint).toBe(false)
    expect((await restricted.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_options_refresh')
    const deniedCall = await restricted.callTool({ name: 'harness_options_refresh', arguments: { harness: 'opencode' } })
      .then((result) => result.isError === true, () => true)
    expect(deniedCall).toBe(true)
    const deniedUpdate = await reader.callTool({ name: 'opencode_models_cache_update', arguments: { harness: 'opencode' } })
      .then((result) => result.isError === true, () => true)
    expect(deniedUpdate).toBe(true)
    expect(native.refreshOptions).not.toHaveBeenCalled()
    const before = HarnessOptionsResultSchema.parse((await reader.callTool({ name: 'harness_options_get', arguments: { harness: 'opencode' } })).structuredContent)
    expect(before.models.map((model) => model.id)).toEqual(['provider/old-model'])
    const local = await app.inject({ method: 'POST', url: '/api/management/harnesses/opencode/refresh',
      headers: { authorization: `Bearer ${readerGrant.token}`, host: 'localhost' }, payload: {} })
    expect(local.statusCode).toBe(200)
    expect(HarnessOptionsResultSchema.parse(local.json()).models[0]?.id).toBe('provider/old-model')
    expect(native.refreshOptions).toHaveBeenLastCalledWith('opencode', 'catalog')
    const localMcp = HarnessOptionsResultSchema.parse((await reader.callTool({ name: 'harness_options_refresh',
      arguments: { harness: 'opencode' } })).structuredContent)
    expect(localMcp.models.map((model) => model.id)).toEqual(['provider/old-model'])
    const deniedHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/opencode/refresh',
      headers: { authorization: `Bearer ${readerGrant.token}`, host: 'localhost' }, payload: { refresh: 'upstream' } })
    expect(deniedHttp.statusCode).toBe(403)
    expect(native.refreshOptions).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual(['provider/old-model'])
    const refreshed = HarnessOptionsResultSchema.parse((await updater.callTool({ name: 'opencode_models_cache_update',
      arguments: { harness: 'opencode' } })).structuredContent)
    expect(refreshed.models.map((model) => model.id)).toEqual(['provider/new-model'])
    const updateHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/opencode/refresh',
      headers: { authorization: `Bearer ${updaterGrant.token}`, host: 'localhost' }, payload: { refresh: 'upstream' } })
    expect(updateHttp.statusCode).toBe(200)
    expect(native.refreshOptions).toHaveBeenLastCalledWith('opencode', 'upstream')
    expect(invalidateChecks).toHaveBeenCalledTimes(4)
    const readback = HarnessOptionsResultSchema.parse((await reader.callTool({ name: 'harness_options_get', arguments: { harness: 'opencode' } })).structuredContent)
    expect(readback.models.map((model) => model.id)).toEqual(['provider/new-model'])
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual(['provider/new-model'])
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app.close()
    await pool.end()
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
