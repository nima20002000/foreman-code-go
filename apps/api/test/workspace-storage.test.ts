import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

it('allows only managed workspace storage and rejects outside paths, runtime and symlink escapes', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'workspace-storage-'))
  try {
    const projects = join(fixture, 'workspaces')
    const runtime = join(fixture, 'runtime')
    const outside = join(fixture, 'outside')
    await Promise.all([mkdir(projects), mkdir(runtime), mkdir(outside)])
    await symlink(outside, join(projects, 'escape'))
    const pool = { query: vi.fn(async () => ({ rows: [{ archived_at: null }] })) } as unknown as pg.Pool
    const commands = { recordAudit: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
    const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local', projects)
    const principal: ManagementPrincipal = {
      id: 'storage-owner', name: 'Storage owner', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions: ['workspace_locations:validate', 'workspace_locations:read', 'workspace_locations:update', 'workspace_locations:provision'], scope: {} }],
    }
    const input = { workspaceId: 'workspace-1', runnerId: 'runner-local', accessMode: 'read-only' as const }
    const allowed = await locations.validate(principal, 'mcp', { ...input, rootPath: projects })
    expect(allowed.location.rootPath).toBe(await realpath(projects))
    for (const rootPath of [outside, runtime, join(projects, 'escape')]) {
      await expect(locations.validate(principal, 'mcp', { ...input, rootPath })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_OUTSIDE_STORAGE' })
      await expect(locations.createProjectFolder(principal, 'workspace-1', rootPath, 'Forbidden')).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_OUTSIDE_STORAGE' })
    }
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(runtime)).toEqual([])
    const created = await locations.createProjectFolder(principal, 'workspace-1', projects, 'Allowed')
    expect(created.validation.location.rootPath).toBe(join(projects, 'Allowed'))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
