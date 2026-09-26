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

it('batch archives workspaces through authenticated MCP with atomic conflicts, active-run protection, scoped denial and replay', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
  const schema = 'batch_page_' + randomUUID().replaceAll('-', '')
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
    const owner = await access.issue({ name: 'Batch owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'batch-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('workspace_batch_archive')
    const first = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'First' })).value
    const second = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Second' })).value
    const input = { commandId: randomUUID(), workspaces: [first, second].map((item) => ({ workspaceId: item.workspace.id, expectedRevision: item.revision })) }
    const reader = await access.issue({ name: 'Reader', audience: 'operator', grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('workspace_batch_archive')
    await expect(denied.callTool({ name: 'workspace_batch_archive', arguments: input })).rejects.toThrow('not found')
    const scoped = await access.issue({ name: 'Scoped', audience: 'operator', grants: [{ actions: ['workspaces:archive'], scope: { workspaceIds: [first.workspace.id] } }], expiresAt: new Date(Date.now() + 60_000) })
    expect((await (await connect(scoped.token)).callTool({ name: 'workspace_batch_archive', arguments: input })).isError).toBe(true)
    const rejected = await client.callTool({ name: 'workspace_batch_archive', arguments: { ...input, commandId: randomUUID(),
      workspaces: [input.workspaces[0], { ...input.workspaces[1], expectedRevision: 99 }],
    } })
    expect(rejected.isError).toBe(true)
    expect((await pool.query('select count(*) from workspaces where archived_at is not null')).rows[0].count).toBe('0')
    const workflow = (await workflows.create(owner.principal, 'http', { workspaceId: first.workspace.id, name: 'Retained workflow', commandId: randomUUID() })).value.workflow
    await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
      values ('version-active',$1,$2,1,'node','{}')`, [first.workspace.id, workflow.id])
    await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values ('run-active',$1,$2,'version-active','running','{}')`, [first.workspace.id, workflow.id])
    const active = await client.callTool({ name: 'workspace_batch_archive', arguments: input })
    expect(active.isError).toBe(true)
    expect(JSON.stringify(active)).toContain('ARCHIVE_BLOCKED_BY_ACTIVE_RUN')
    expect((await pool.query('select count(*) from workspaces where archived_at is not null')).rows[0].count).toBe('0')
    await pool.query("update runs set execution_state='completed' where id='run-active'")
    const result = c.WorkspaceBatchArchiveResultSchema.parse((await client.callTool({ name: 'workspace_batch_archive', arguments: input })).structuredContent)
    expect(result.replayed).toBe(false)
    expect(result.value.workspaceIds.sort()).toEqual([first.workspace.id, second.workspace.id].sort())
    const replay = c.WorkspaceBatchArchiveResultSchema.parse((await client.callTool({ name: 'workspace_batch_archive', arguments: input })).structuredContent)
    expect(replay.replayed).toBe(true)
    const listing = c.ManagedWorkspacePageSchema.parse((await client.callTool({ name: 'workspace_list', arguments: {} })).structuredContent)
    expect(listing.items).toEqual([])
    const readback = c.ManagedWorkspaceSchema.parse((await client.callTool({ name: 'workspace_get', arguments: { workspaceId: first.workspace.id } })).structuredContent)
    expect(readback.archivedAt).not.toBeNull(); expect(readback.revision).toBe(first.revision + 1)
    expect((await pool.query('select count(*) from workflows')).rows[0].count).toBe('1')
    expect((await pool.query('select count(*) from runs')).rows[0].count).toBe('1')
    expect((await pool.query("select count(*) from management_audit where action='workspace.batch_archive' and outcome='succeeded'")).rows[0].count).toBe('1')
  } finally {
    for (const client of clients) await client.close()
    await app.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
}, 30_000)
