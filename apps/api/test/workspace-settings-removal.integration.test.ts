import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@graphql/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('removes a workspace through authenticated MCP with denied access, replay and persisted readback', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
  const schema = 'settings_removal_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands)
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  const workflows = new WorkflowManagementService(pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Removal owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'settings-removal-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const reader = await access.issue({ name: 'Reader', audience: 'operator', grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const denied = await connect(reader.token)

    // The single-workspace removal action uses the same authenticated archive capability.
    const single = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Single removal' })).value
    const singleInput = { commandId: randomUUID(), workspaceId: single.workspace.id, expectedRevision: single.revision }
    await expect(denied.callTool({ name: 'workspace_archive', arguments: singleInput })).rejects.toThrow('not found')
    const removed = c.ManagedWorkspaceCommandResultSchema.parse((await client.callTool({ name: 'workspace_archive', arguments: singleInput })).structuredContent)
    expect(removed.value.archivedAt).not.toBeNull()
    expect(c.ManagedWorkspaceCommandResultSchema.parse((await client.callTool({ name: 'workspace_archive', arguments: singleInput })).structuredContent).replayed).toBe(true)
    const persisted = c.ManagedWorkspaceSchema.parse((await client.callTool({ name: 'workspace_get', arguments: { workspaceId: single.workspace.id } })).structuredContent)
    expect(persisted.archivedAt).toBe(removed.value.archivedAt)
    expect(persisted.revision).toBe(single.revision + 1)
  } finally {
    for (const client of clients) await client.close()
    await app.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
}, 30_000)
