import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

it('creates a ready project folder once, preserves defaults and rejects collisions and traversal', async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
  const admin = new pg.Pool({ connectionString })
  const schema = 'workspace_create_' + randomUUID().replaceAll('-', '')
  const parentPath = await mkdtemp(join(tmpdir(), 'workspace-create-'))
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await applyApplicationMigrations(pool)
    const principal = (await new PostgresAccessService(pool).issue({
      name: 'Creation test', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['workspaces:create', 'workspaces:read', 'workspace_locations:read', 'workspace_locations:update', 'workspace_locations:provision'], scope: {} }],
    })).principal
    const defaults = new PostgresFoundationSettingsRepository(pool)
    expect((await defaults.getWorkspaceDefaults()).value.parentPath).toBe(join(homedir(), 'Desktop'))
    await defaults.updateWorkspaceDefaults({ suggestedName: 'Project', description: '', parentPath }, 0)
    const commands = new PostgresCommandCoordinator(pool)
    const locations = new WorkspaceLocationService(pool, commands)
    const service = new WorkspaceManagementService(pool, commands, locations, defaults)
    const input = { commandId: randomUUID(), name: 'My Project ü', parentPath: (await defaults.getWorkspaceDefaults()).value.parentPath! }
    const created = await service.create(principal, 'http', input)
    expect(created.value.executionLocation?.rootPath).toBe(join(parentPath, input.name))
    expect(created.value.locationValidation.status).toBe('ready')
    expect((await service.create(principal, 'http', input)).replayed).toBe(true)
    expect(await readdir(parentPath)).toEqual([input.name])
    await expect(service.create(principal, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'WORKSPACE_FOLDER_EXISTS' })
    await expect(service.create(principal, 'http', { ...input, commandId: randomUUID(), name: '../escape' })).rejects.toMatchObject({ code: 'WORKSPACE_FOLDER_NAME_INVALID' })
    await expect(service.create(principal, 'mcp', { ...input, commandId: randomUUID(), name: 'MCP' })).rejects.toMatchObject({ code: 'BROWSER_REQUIRED' })
    const restricted = { ...principal, grants: [{ actions: ['workspaces:create' as const], scope: {} }] }
    await expect(service.create(restricted, 'http', { ...input, commandId: randomUUID(), name: 'Denied' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await defaults.updateWorkspaceDefaults({ suggestedName: 'Elsewhere', description: '', parentPath: tmpdir() }, 1)
    expect((await service.get(principal, created.value.workspace.id)).executionLocation?.rootPath).toBe(join(parentPath, input.name))
    expect((await pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(1)
  } finally {
    await pool.end()
    await admin.query(`drop schema "${schema}" cascade`)
    await admin.end()
    await rm(parentPath, { recursive: true, force: true })
  }
}, 30_000)
