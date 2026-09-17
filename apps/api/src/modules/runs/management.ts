import { randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  RunActivitySchema,
  WorkflowRunSchema,
  WorkflowVersionSchema,
  type RunInput,
} from '@graphql/contracts'
import { GraphDraftSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'

import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { authorizedPage } from '../access/authorizedPage.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { LangGraphWorkflowEngine } from './engine.js'
import type { PostgresRunRepository } from './postgres.js'
import { validateExecutableTopology } from './topology.js'
import { requiredLocationAccess, WorkspaceLocationService } from '../workspaces/location.js'
import { acceptedRunApproval, validateWorkflowApproval } from '../workflows/approval.js'
import { acceptRunAuthority, bindRunAuthority } from '../access/runAuthority.js'
import { assertTriggerDispatch } from '../workflows/triggerAuthority.js'

export class RunManagementService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: PostgresCommandCoordinator,
    private readonly runs: PostgresRunRepository,
    private readonly engine: LangGraphWorkflowEngine,
    private readonly locations: WorkspaceLocationService,
  ) {}

  private visibleRun(principal: ManagementPrincipal, run: ReturnType<typeof WorkflowRunSchema.parse>) {
    const visible = { ...run }
    delete visible.authorizationPrincipalId
    if (!isAuthorized(principal, 'workspace_locations:read', { workspaceId: run.workspaceId })) {
      delete visible.executionLocation
    }
    return visible
  }

  async list(principal: ManagementPrincipal, input: { workspaceId: string; workflowId?: string | undefined; cursor?: string | undefined; limit: number }) {
    const page = await authorizedPage({
      principal, action: 'runs:read', cursor: input.cursor, limit: input.limit,
      read: async (cursor, limit) => (await this.pool.query<{ record: unknown }>(
        `select record from runs where workspace_id = $1
         and ($2::text is null or workflow_id = $2)
         and ($3::text is null or id > $3)
         order by id limit $4`, [input.workspaceId, input.workflowId ?? null, cursor ?? null, limit],
      )).rows.map((row) => WorkflowRunSchema.parse(row.record)),
      id: (item) => item.id,
      resource: (item) => ({ workspaceId: item.workspaceId, workflowId: item.workflowId, runId: item.id }),
    })
    return { ...page, items: page.items.map((item) => this.visibleRun(principal, item)) }
  }

  async get(principal: ManagementPrincipal, workspaceId: string, runId: string) {
    const run = await this.runs.getForWorkspace(workspaceId, runId)
    if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${runId}' was not found.`, 404)
    requireAuthorization(principal, 'runs:read', { workspaceId, workflowId: run.workflowId, runId })
    const details = await this.runs.getDetails(workspaceId, runId)
    if (!details) return undefined
    const canReadLocation = isAuthorized(principal, 'workspace_locations:read', { workspaceId })
    const executions = details.executions.map((execution) => {
      const visible = { ...execution }
      if (!canReadLocation) {
        delete visible.workingDirectory
        delete visible.runtimeDirectory
      }
      return visible
    })
    return { ...details, run: this.visibleRun(principal, details.run), executions }
  }

  async events(principal: ManagementPrincipal, input: { workspaceId: string; runId: string; afterSequence?: number | undefined; limit: number }) {
    const run = await this.runs.getForWorkspace(input.workspaceId, input.runId)
    if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${input.runId}' was not found.`, 404)
    requireAuthorization(principal, 'runs:read', { workspaceId: input.workspaceId, workflowId: run.workflowId, runId: input.runId })
    const rows = await this.pool.query<{
      sequence: string; source: string; kind: string; harness_execution_id: string | null;
      occurred_at: Date; payload: Record<string, unknown>
    }>(
      `select sequence::text, source, kind, harness_execution_id, occurred_at, payload
       from run_activity where run_id = $1 and sequence > $2 order by sequence limit $3`,
      [input.runId, input.afterSequence ?? -1, input.limit + 1],
    )
    const items = rows.rows.slice(0, input.limit).map((row) => RunActivitySchema.parse({
      id: `activity-${input.runId}-${row.sequence}`, runId: input.runId, sequence: Number(row.sequence),
      source: row.source, kind: row.kind,
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
      occurredAt: row.occurred_at.toISOString(), payload: row.payload,
    }))
    return { items, pageInfo: { nextCursor: rows.rows.length > input.limit ? String(items.at(-1)!.sequence) : null } }
  }

  async start(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; workflowVersionId: string; expectedLocationRevision: number;
    commandId: string; input: RunInput;
    draftId?: string | undefined; expectedDraftRevision?: number | undefined; triggerJobId?: string | undefined
  }) {
    requireAuthorization(principal, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
    const execution = await this.commands.execute({
      principal, source, operation: 'run.start', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}:version:${input.workflowVersionId}`, payload: input,
      perform: async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
        if (input.triggerJobId) await assertTriggerDispatch(client, principal, {...input, triggerJobId: input.triggerJobId})
        const parents = await client.query<{
          workspace_archived_at: Date | null; workflow_archived_at: Date | null; current_version_id: string | null
        }>(
          `select ws.archived_at as workspace_archived_at, wf.archived_at as workflow_archived_at, wf.current_version_id
           from workspaces ws join workflows wf on wf.workspace_id = ws.id
           where ws.id = $1 and wf.id = $2 for update of wf`, [input.workspaceId, input.workflowId],
        )
        const parent = parents.rows[0]
        if (!parent) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${input.workflowId}' was not found.`, 404)
        if (parent.workspace_archived_at || parent.workflow_archived_at) throw new DomainError('PARENT_ARCHIVED', 'Archived workspaces or workflows cannot start new runs.', 409)
        if (parent.current_version_id !== input.workflowVersionId) {
          throw new DomainError('WORKFLOW_VERSION_UNSUPPORTED', 'Only the current explicitly saved workflow version can be started.', 409, { currentVersionId: parent.current_version_id })
        }
        if ((input.draftId === undefined) !== (input.expectedDraftRevision === undefined)) {
          throw new DomainError('DRAFT_IDENTITY_REQUIRED', 'Supply both draft identity and revision.', 400)
        }
        if (input.draftId !== undefined) {
          const row = await client.query<{ record: unknown }>(
            `select record from graph_drafts where id = $1 and workspace_id = $2 and workflow_id = $3
             and discarded_at is null for share`, [input.draftId, input.workspaceId, input.workflowId],
          )
          const draft = row.rows[0] ? GraphDraftSchema.parse(row.rows[0].record) : undefined
          if (!draft || draft.revision !== input.expectedDraftRevision || draft.publishedRevision !== draft.revision
            || draft.baseWorkflowVersionId !== input.workflowVersionId) {
            throw new DomainError('DISPLAYED_GRAPH_NOT_PUBLISHED', 'The displayed graph changed or is unpublished. Reload and save it before starting.', 409)
          }
        }
        const versionRow = await client.query<{ record: unknown }>(
          `select record from workflow_versions where id = $1 and workspace_id = $2 and workflow_id = $3`,
          [input.workflowVersionId, input.workspaceId, input.workflowId],
        )
        if (!versionRow.rows[0]) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', `Workflow version '${input.workflowVersionId}' was not found.`, 404)
        const version = WorkflowVersionSchema.parse(versionRow.rows[0].record)
        validateExecutableTopology(version)
        const approval = acceptedRunApproval(version)
        const currentConfigurations = await client.query<{ id: string; current_configuration_version_id: string | null; configuration_record: unknown }>(
          `select agents.id, agents.current_configuration_version_id, versions.record as configuration_record
           from agents join agent_configuration_versions versions on versions.id = agents.current_configuration_version_id
           where agents.workspace_id = $1 and agents.archived_at is null and agents.id = any($2::text[])`,
          [input.workspaceId, Object.keys(version.agentConfigurationVersionIds)],
        )
        if (currentConfigurations.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
          || currentConfigurations.rows.some((row) => row.current_configuration_version_id !== version.agentConfigurationVersionIds[row.id])) {
          throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Agent settings changed. Save the graph again before starting it.', 409)
        }
        const configurations = currentConfigurations.rows.map((row) => AgentConfigurationVersionSchema.parse(row.configuration_record))
        if (approval) validateWorkflowApproval(version.definition, approval, configurations.map((configuration) => ({
          id: configuration.agentId, productRole: configuration.productRole, harnessConfiguration: configuration.harness,
        })))
        const executionLocation = await this.locations.snapshot(
          client, input.workspaceId, input.expectedLocationRevision, requiredLocationAccess(configurations),
        )
        const authority = await acceptRunAuthority(client, principal, approval?.handler === 'operator')
        requireAuthorization(authority.principal, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
        requireAuthorization(authority.principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
        const run = WorkflowRunSchema.parse({
          id: `run-${randomUUID()}`, workspaceId: input.workspaceId, workflowId: input.workflowId,
          workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds,
          executionLocation,
          ...(approval ? { approval } : {}),
          authorizationPrincipalId: authority.principal.id,
          executionCondition: version.definition.executionCondition, executionState: 'queued', outcome: 'pending',
          input: input.input, createdAt: new Date().toISOString(),
        })
        await this.runs.create(run, client)
        await bindRunAuthority(client, run.id, authority)
        await this.runs.recordActivity(run.id, 'backend', 'run_state_changed', { executionState: 'queued' }, undefined, client)
        return run
      },
    })
    if (!execution.replayed) setImmediate(() => { void this.engine.start(execution.value.id).catch(() => undefined) })
    return { run: this.visibleRun(principal, execution.value), accepted: true as const, replayed: execution.replayed }
  }

  async stop(principal: ManagementPrincipal, source: 'http' | 'mcp', input: { workspaceId: string; runId: string; commandId: string }) {
    const run = await this.runs.getForWorkspace(input.workspaceId, input.runId)
    if (!run) throw new DomainError('RUN_NOT_FOUND', `Run '${input.runId}' was not found.`, 404)
    requireAuthorization(principal, 'runs:stop', { workspaceId: input.workspaceId, workflowId: run.workflowId, runId: input.runId })
    const execution = await this.commands.execute({
      principal, source, operation: 'run.stop', commandId: input.commandId, dedicatedConnection: true,
      targetKey: `run:${input.runId}`, payload: input,
      perform: async (client) => {
        // Reuse the coordinator's lease. Ownership uses its dedicated session;
        // neither this read nor orphan settlement needs a second pool lease.
        const latestRow = await client.query<{ record: unknown }>(
          'select record from runs where workspace_id = $1 and id = $2', [input.workspaceId, input.runId],
        )
        const latest = latestRow.rows[0] ? WorkflowRunSchema.parse(latestRow.rows[0].record) : undefined
        if (!latest) throw new DomainError('RUN_NOT_FOUND', `Run '${input.runId}' was not found.`, 404)
        if (latest.executionState === 'completed' && !await this.runs.hasPendingCleanup(input.runId, client)) {
          return { runId: input.runId, status: 'already_terminal' as const, processStopped: false }
        }
        const accepted = await this.engine.cancel(input.runId, client)
        return accepted
          ? { runId: input.runId, status: 'accepted' as const, processStopped: false }
          : { runId: input.runId, status: 'not_owner' as const, processStopped: false }
      },
    })
    // Older receipts may have inferred termination from a terminal record.
    // This API has no process-exit observation, including on receipt replay.
    return { ...execution.value, processStopped: false, replayed: execution.replayed }
  }
}
