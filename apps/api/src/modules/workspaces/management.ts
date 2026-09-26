import { rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import {
  ManagedWorkspaceSchema,
  WorkspaceBatchArchiveInputSchema,
  type WorkspaceBatchArchiveInput,
  type ManagementPrincipal,
  type ManagedWorkspace,
  type WorkspaceCreateInput,
} from '@graphql/contracts/management'
import { WorkspaceSchema } from '@graphql/contracts'
import type pg from 'pg'

import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkspaceLocationService } from './location.js'
import { replayWorkspaceResult } from './receipts.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'

interface WorkspaceRow { record: unknown; revision: string; archived_at: Date | null }

function managed(row: WorkspaceRow): ManagedWorkspace {
  return ManagedWorkspaceSchema.parse({
    workspace: WorkspaceSchema.parse(row.record),
    revision: Number(row.revision),
    archivedAt: row.archived_at?.toISOString() ?? null,
    executionLocation: null,
    locationRevision: 0,
    locationValidation: { status: 'restricted' },
  })
}

export class WorkspaceManagementService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: PostgresCommandCoordinator,
    private readonly locations: WorkspaceLocationService,
    private readonly defaults: Pick<PostgresFoundationSettingsRepository, 'getWorkspaceDefaults'> = new PostgresFoundationSettingsRepository(pool),
  ) {}

  async list(principal: ManagementPrincipal, input: { cursor?: string | undefined; limit: number; includeArchived: boolean }) {
    if (!hasAction(principal, 'workspaces:read')) requireAuthorization(principal, 'workspaces:read')
    const relevant = principal.grants.filter((grant) => grant.actions.includes('workspaces:read')
      && grant.scope.workflowIds === undefined && grant.scope.runIds === undefined)
    const allowedWorkspaceIds = relevant.some((grant) => grant.scope.workspaceIds === undefined)
      ? undefined
      : [...new Set(relevant.flatMap((grant) => grant.scope.workspaceIds ?? []))]
    const rows = await this.pool.query<WorkspaceRow>(
      `select record, revision, archived_at from workspaces
       where ($1::text is null or id > $1) and ($2 or archived_at is null)
       and ($4::text[] is null or id = any($4))
       order by id limit $3`,
      [input.cursor ?? null, input.includeArchived, input.limit + 1, allowedWorkspaceIds ?? null],
    )
    const visible = rows.rows
      .map(managed)
      .filter((item) => {
        try { requireAuthorization(principal, 'workspaces:read', { workspaceId: item.workspace.id }); return true } catch { return false }
      })
    const page = visible.slice(0, input.limit)
    const locationIds = page.filter((item) => isAuthorized(principal, 'workspace_locations:read', { workspaceId: item.workspace.id }))
      .map((item) => item.workspace.id)
    const locations = locationIds.length ? await this.locations.inspectMany(principal, locationIds) : new Map()
    const items = page.map((item) => ManagedWorkspaceSchema.parse({ ...item, ...locations.get(item.workspace.id) }))
    return { items, pageInfo: { nextCursor: visible.length > input.limit ? items.at(-1)!.workspace.id : null } }
  }

  async get(principal: ManagementPrincipal, workspaceId: string): Promise<ManagedWorkspace> {
    requireAuthorization(principal, 'workspaces:read', { workspaceId })
    const result = await this.pool.query<WorkspaceRow>(
      'select record, revision, archived_at from workspaces where id = $1', [workspaceId],
    )
    if (!result.rows[0]) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, 404)
    const base = managed(result.rows[0])
    if (!isAuthorized(principal, 'workspace_locations:read', { workspaceId })) return base
    return ManagedWorkspaceSchema.parse({ ...base, ...await this.locations.inspect(principal, workspaceId) })
  }

  async create(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkspaceCreateInput) {
    requireAuthorization(principal, 'workspaces:create')
    return this.commands.execute({
      replayResult: replayWorkspaceResult,
      principal, source, operation: 'workspace.create', commandId: input.commandId,
      targetKey: 'workspaces:new', payload: input,
      perform: async (client) => {
        const defaults = input.description === undefined ? await this.defaults.getWorkspaceDefaults(client) : undefined
        const description = input.description ?? defaults?.value.description ?? ''
        const now = new Date().toISOString()
        const workspace = WorkspaceSchema.parse({
          id: `workspace-${randomUUID()}`, name: input.name,
          ...(description ? { description } : {}),
          createdAt: now, updatedAt: now,
        })
        const folder = input.parentPath
          ? await this.locations.createProjectFolder(principal, workspace.id, input.parentPath, workspace.name)
          : undefined
        try {
          const result = await client.query<WorkspaceRow>(
            `insert into workspaces (id, record, execution_location, execution_location_identity, location_revision)
             values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5)
             returning record, revision, archived_at`,
            [workspace.id, JSON.stringify(workspace), folder ? JSON.stringify(folder.validation.location) : null,
              folder ? JSON.stringify(folder.identity) : null, folder ? 1 : 0],
          )
          const value = managed(result.rows[0]!)
          return folder ? ManagedWorkspaceSchema.parse({ ...value,
            executionLocation: folder.validation.location, locationRevision: 1,
            locationValidation: { status: 'ready', checkedAt: folder.validation.checkedAt },
          }) : value
        } catch (error) {
          // Only remove the empty folder created by this attempt, never existing project content.
          if (folder) await rmdir(folder.validation.location.rootPath).catch(() => undefined)
          throw error
        }
      },
    })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; commandId: string; expectedRevision: number; name?: string | undefined; description?: string | null | undefined
  }) {
    requireAuthorization(principal, 'workspaces:update', { workspaceId: input.workspaceId })
    return this.commands.execute({
      replayResult: replayWorkspaceResult,
      principal, source, operation: 'workspace.update', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}`, payload: input,
      perform: async (client) => {
        const current = await client.query<WorkspaceRow>(
          'select record, revision, archived_at from workspaces where id = $1 for update', [input.workspaceId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${input.workspaceId}' was not found.`, 404)
        if (row.archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot be edited.', 409)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workspace changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const previous = WorkspaceSchema.parse(row.record)
        const workspace = WorkspaceSchema.parse({
          ...previous,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description === null ? { description: undefined }
            : input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date().toISOString(),
        })
        const result = await client.query<WorkspaceRow>(
          `update workspaces set record = $2::jsonb, revision = revision + 1
           where id = $1 returning record, revision, archived_at`,
          [input.workspaceId, JSON.stringify(workspace)],
        )
        return managed(result.rows[0]!)
      },
    })
  }

  async archiveBatch(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: WorkspaceBatchArchiveInput) {
    const input = WorkspaceBatchArchiveInputSchema.parse(raw)
    for (const item of input.workspaces) requireAuthorization(principal, 'workspaces:archive', { workspaceId: item.workspaceId })
    const ids = input.workspaces.map((item) => item.workspaceId).sort()
    return this.commands.execute({
      principal, source, operation: 'workspace.batch_archive', commandId: input.commandId,
      targetKey: 'workspaces:batch', payload: input,
      perform: async (client) => {
        // Match child admission locks in stable order, in one database round trip.
        await client.query(
          `select pg_advisory_xact_lock(hashtext(lock_key)) from
           (select 'admission:workspace:' || id as lock_key from unnest($1::text[]) as selected(id) order by id) locks`, [ids],
        )
        const current = await client.query<{ id: string; revision: string }>(
          'select id, revision from workspaces where id = any($1::text[]) order by id for update', [ids],
        )
        if (current.rows.length !== ids.length) throw new DomainError('WORKSPACE_NOT_FOUND', 'A selected workspace was not found. Nothing was deleted.', 404)
        const revisions = new Map(input.workspaces.map((item) => [item.workspaceId, item.expectedRevision]))
        if (current.rows.some((row) => Number(row.revision) !== revisions.get(row.id))) {
          throw new DomainError('REVISION_CONFLICT', 'A selected workspace changed. Nothing was deleted. Reload the list and select again.', 409)
        }
        const active = await client.query(
          `select 1 from runs where workspace_id = any($1::text[]) and execution_state <> 'completed' limit 1`, [ids],
        )
        if (active.rows.length) throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_RUN', 'A selected workspace has active runs. Nothing was deleted. Settle active work and try again.', 409)
        await client.query(
          `update workspaces set archived_at = coalesce(archived_at, now()), revision = revision + 1
           where id = any($1::text[])`, [ids],
        )
        return { workspaceIds: ids }
      },
    })
  }

  async archive(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; commandId: string; expectedRevision: number
  }) {
    requireAuthorization(principal, 'workspaces:archive', { workspaceId: input.workspaceId })
    return this.commands.execute({
      replayResult: replayWorkspaceResult,
      principal, source, operation: 'workspace.archive', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}`, payload: input,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
        const current = await client.query<WorkspaceRow>(
          'select record, revision, archived_at from workspaces where id = $1 for update', [input.workspaceId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${input.workspaceId}' was not found.`, 404)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workspace changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const active = await client.query<{ count: string }>(
          `select count(*) from runs where workspace_id = $1 and execution_state <> 'completed'`, [input.workspaceId],
        )
        if (Number(active.rows[0]?.count ?? 0) > 0) {
          throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_RUN', 'Settle active work before archiving the workspace.', 409)
        }
        const result = await client.query<WorkspaceRow>(
          `update workspaces set archived_at = coalesce(archived_at, now()), revision = revision + 1
           where id = $1 returning record, revision, archived_at`, [input.workspaceId],
        )
        return managed(result.rows[0]!)
      },
    })
  }
}
