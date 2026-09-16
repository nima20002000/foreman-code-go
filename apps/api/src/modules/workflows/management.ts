import { randomUUID } from 'node:crypto'

import { DEFAULT_WORKFLOW_APPROVAL_HANDLER, WorkflowDefaultsSchema, WorkflowDefinitionSchema } from '@graphql/contracts'
import {
  ManagedWorkflowSchema,
  type ManagedWorkflow,
  type ManagementPrincipal,
} from '@graphql/contracts/management'
import type pg from 'pg'

import { requireAuthorization } from '../access/policy.js'
import { authorizedPage } from '../access/authorizedPage.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

interface WorkflowRow { record: unknown; revision: string; current_version_id: string | null; archived_at: Date | null }

function managed(row: WorkflowRow): ManagedWorkflow {
  return ManagedWorkflowSchema.parse({
    workflow: WorkflowDefinitionSchema.parse(row.record),
    revision: Number(row.revision), currentVersionId: row.current_version_id,
    archivedAt: row.archived_at?.toISOString() ?? null,
  })
}

export class WorkflowManagementService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  async list(principal: ManagementPrincipal, input: {
    workspaceId: string; cursor?: string | undefined; limit: number; includeArchived: boolean
  }) {
    return authorizedPage({
      principal, action: 'workflows:read', cursor: input.cursor, limit: input.limit,
      read: async (cursor, limit) => (await this.pool.query<WorkflowRow>(
        `select record, revision, current_version_id, archived_at from workflows
         where workspace_id = $1 and ($2::text is null or id > $2) and ($3 or archived_at is null)
         order by id limit $4`, [input.workspaceId, cursor ?? null, input.includeArchived, limit],
      )).rows.map(managed),
      id: (item) => item.workflow.id,
      resource: (item) => ({ workspaceId: input.workspaceId, workflowId: item.workflow.id }),
    })
  }

  async get(principal: ManagementPrincipal, workspaceId: string, workflowId: string): Promise<ManagedWorkflow> {
    requireAuthorization(principal, 'workflows:read', { workspaceId, workflowId })
    const result = await this.pool.query<WorkflowRow>(
      `select record, revision, current_version_id, archived_at from workflows
       where workspace_id = $1 and id = $2`, [workspaceId, workflowId],
    )
    if (!result.rows[0]) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${workflowId}' was not found.`, 404)
    return managed(result.rows[0])
  }

  async create(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; commandId: string; name: string; description?: string | undefined
  }) {
    requireAuthorization(principal, 'workflows:create', { workspaceId: input.workspaceId })
    return this.commands.execute({
      principal, source, operation: 'workflow.create', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:workflows:new`, payload: input,
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const now = new Date().toISOString()
        const setting = await client.query<{ record: unknown }>(
          'select record from application_settings where key=$1', ['workflow-defaults-v1'],
        )
        const approvalHandler = setting.rows[0]
          ? WorkflowDefaultsSchema.parse(setting.rows[0].record).approvalHandler
          : DEFAULT_WORKFLOW_APPROVAL_HANDLER
        const workflow = WorkflowDefinitionSchema.parse({
          id: `workflow-${randomUUID()}`, workspaceId: input.workspaceId, name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          // Drafts copy the selected handler immediately. Executable Save
          // resolves and validates the designated Orchestrator when required.
          approval: { handler: approvalHandler },
          executionCondition: { kind: 'manual' }, nodes: [], edges: [], createdAt: now, updatedAt: now,
        })
        const result = await client.query<WorkflowRow>(
          `insert into workflows (id, workspace_id, record) values ($1, $2, $3::jsonb)
           returning record, revision, current_version_id, archived_at`,
          [workflow.id, input.workspaceId, JSON.stringify(workflow)],
        )
        return managed(result.rows[0]!)
      },
    })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; commandId: string; expectedRevision: number;
    name?: string | undefined; description?: string | null | undefined
  }) {
    requireAuthorization(principal, 'workflows:update', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'workflow.update', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}`, payload: input,
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const current = await client.query<WorkflowRow>(
          `select record, revision, current_version_id, archived_at from workflows
           where workspace_id = $1 and id = $2 for update`, [input.workspaceId, input.workflowId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${input.workflowId}' was not found.`, 404)
        if (row.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.', 409)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const previous = WorkflowDefinitionSchema.parse(row.record)
        const workflow = WorkflowDefinitionSchema.parse({
          ...previous,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description === null ? { description: undefined }
            : input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date().toISOString(),
        })
        const result = await client.query<WorkflowRow>(
          `update workflows set record = $3::jsonb, revision = revision + 1
           where workspace_id = $1 and id = $2 returning record, revision, current_version_id, archived_at`,
          [input.workspaceId, input.workflowId, JSON.stringify(workflow)],
        )
        return managed(result.rows[0]!)
      },
    })
  }

  async archive(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; commandId: string; expectedRevision: number
  }) {
    requireAuthorization(principal, 'workflows:archive', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'workflow.archive', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}`, payload: input,
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const current = await client.query<WorkflowRow>(
          `select record, revision, current_version_id, archived_at from workflows
           where workspace_id = $1 and id = $2 for update`, [input.workspaceId, input.workflowId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${input.workflowId}' was not found.`, 404)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const active = await client.query<{ count: string }>(
          `select count(*) from runs where workspace_id = $1 and workflow_id = $2 and execution_state <> 'completed'`,
          [input.workspaceId, input.workflowId],
        )
        if (Number(active.rows[0]?.count ?? 0) > 0) {
          throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_RUN', 'Settle active work before archiving the workflow.', 409)
        }
        const result = await client.query<WorkflowRow>(
          `update workflows set archived_at = coalesce(archived_at, now()), revision = revision + 1
           where workspace_id = $1 and id = $2 returning record, revision, current_version_id, archived_at`,
          [input.workspaceId, input.workflowId],
        )
        return managed(result.rows[0]!)
      },
    })
  }
}
