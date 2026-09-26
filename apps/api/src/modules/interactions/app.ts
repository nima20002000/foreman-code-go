import {
  IdSchema,
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  DurableInteractionSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  HarnessExecutionSchema,
} from '@graphql/contracts'
import { AcceptedWorkflowRunV3Schema, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { resolveImmutableApprovalRoute } from '../workflows/approvalRoutes.js'
import { assertWave25WorkerBinding } from './wave25/credentialAuthority.js'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'

import { workerScope, workerScopesForAction, hasWorkerAction, requireReadableInteraction, requireRespondableInteraction } from '../access/appPolicy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { PostgresInteractionRepository } from './postgres.js'
import type { InteractionService } from './service.js'

const CURSOR_PREFIX = 'interaction:'
export const AppInteractionListInputSchema = ListInteractionsRequestSchema.pick({ cursor: true, limit: true }).strict()

function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url')
}

export function decodeInteractionCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
      || !decoded.startsWith(CURSOR_PREFIX) || decoded.length === CURSOR_PREFIX.length) throw new Error('invalid')
    const rawId = decoded.slice(CURSOR_PREFIX.length)
    const id = IdSchema.parse(rawId)
    if (id !== rawId || !/^[\x21-\x7e]+$/.test(id)) throw new Error('invalid')
    return id
  } catch {
    throw new DomainError('INVALID_CURSOR', 'The interaction cursor is invalid.', 400)
  }
}

export interface AppInteractionService {
  context(principal: ManagementPrincipal): Promise<unknown>
  canRead(principal: ManagementPrincipal): Promise<boolean>
  canRespond(principal: ManagementPrincipal): Promise<boolean>
  list(principal: ManagementPrincipal, input: unknown): Promise<unknown>
  get(principal: ManagementPrincipal, interactionId: string): Promise<unknown>
  respond(principal: ManagementPrincipal, input: unknown): Promise<unknown>
}

export class PostgresAppInteractionService implements AppInteractionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly interactions: PostgresInteractionRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly orchestration?: Pick<InteractionService, 'respond'>,
  ) {}

  async context(principal: ManagementPrincipal) {
    const scope = workerScope(principal)
    const readAllowed = await this.canRead(principal)
    const responseAllowed = await this.canRespond(principal)
    return {
      principal: {
        id: principal.id,
        audience: 'worker' as const,
        agentId: principal.agentId!,
        expiresAt: principal.expiresAt,
      },
      scope,
      capabilities: {
        contextGet: true,
        interactionList: readAllowed,
        interactionGet: readAllowed,
        interactionRespond: responseAllowed,
      },
    }
  }

  async canRead(principal: ManagementPrincipal): Promise<boolean> {
    workerScope(principal)
    return hasWorkerAction(principal, 'interactions:read')
  }

  async canRespond(principal: ManagementPrincipal): Promise<boolean> {
    if (!this.orchestration) return false
    if (!hasWorkerAction(principal, 'interactions:respond') || !hasWorkerAction(principal, 'interactions:read')) return false
    try { await assertWave25WorkerBinding(this.pool, principal.id) }
    catch (error) { if (error instanceof DomainError) return false; throw error }
    workerScope(principal)
    const scopes = workerScopesForAction(principal, 'interactions:respond')
    // Discovery uses the same exact reviewer occurrence as its bound credential.
    // No pending request is required: the entry node discovers tools before handoff.
    const result = await this.pool.query<{ run: unknown; version: unknown; execution: unknown; node_id: string }>(
      `select r.record as run,v.record as version,e.record as execution,e.workflow_node_id as node_id
       from worker_credential_bindings b join harness_executions e on e.id=b.execution_id
         and e.run_id=b.run_id and e.agent_id=b.agent_id
       join runs r on r.id=e.run_id
       join workflow_versions v on v.id=r.workflow_version_id and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
       join agent_configuration_versions c on c.id=(r.record->'agentConfigurationVersionIds'->>$2)
         and c.workspace_id=r.workspace_id and c.agent_id=e.agent_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null
         and c.record->>'productRole'='orchestrator'
         and r.execution_state in ('queued','running','waiting')
         and exists (select 1 from jsonb_to_recordset($3::jsonb)
           as response_grant("workspaceIds" text[],"workflowIds" text[],"runIds" text[])
           where r.workspace_id=any(response_grant."workspaceIds")
             and r.workflow_id=any(response_grant."workflowIds") and r.id=any(response_grant."runIds"))`,
      [principal.id, principal.agentId, JSON.stringify(scopes)],
    )
    return result.rows.some((row) => {
      const run = AcceptedWorkflowRunV3Schema.safeParse(row.run)
      const version = WorkflowVersionV3Schema.safeParse(row.version)
      const execution = HarnessExecutionSchema.safeParse(row.execution)
      if (!run.success || !version.success || !execution.success) return false
      const r = run.data, v = version.data, e = execution.data
      if (r.workflowVersionId !== v.id || r.workspaceId !== v.workspaceId || r.workflowId !== v.workflowId
        || v.definition.id !== r.workflowId || v.definition.workspaceId !== r.workspaceId
        || e.runId !== r.id || e.agentId !== principal.agentId || e.workflowNodeId !== row.node_id
        || e.agentConfigurationVersionId !== r.agentConfigurationVersionIds[e.agentId]
        || e.agentConfigurationVersionId !== v.agentConfigurationVersionIds[e.agentId]
        || [r.approval, v.approval, v.definition.approval].some((approval) =>
          approval?.handler !== 'orchestrator' || approval.designatedOrchestratorAgentId !== e.agentId)) return false
      return v.definition.nodes.some((requester) => resolveImmutableApprovalRoute(
        v, requester.id, requester.agentId,
      )?.orchestratorNodeId === e.workflowNodeId)
    })
  }

  async list(principal: ManagementPrincipal, input: unknown) {
    const parsed = AppInteractionListInputSchema.parse(input)
    // The summary scope mixes actions and grants; it is not an authorization predicate.
    workerScope(principal)
    const scopes = workerScopesForAction(principal, 'interactions:read')
    const afterId = decodeInteractionCursor(parsed.cursor)
    const rows = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where status = 'pending'
         and exists (
           select 1 from jsonb_to_recordset($1::jsonb)
             as read_grant("workspaceIds" text[], "workflowIds" text[], "runIds" text[])
           where workspace_id = any(read_grant."workspaceIds")
             and workflow_id = any(read_grant."workflowIds")
             and run_id = any(read_grant."runIds")
         )
         and ($2::text is null or id > $2)
       order by id limit $3`,
      [JSON.stringify(scopes), afterId ?? null, parsed.limit + 1],
    )
    // Visibility is decided before LIMIT. EXISTS also avoids duplicate page slots
    // when more than one read grant authorizes the same interaction.
    const visible = rows.rows.map((row) => DurableInteractionSchema.parse(row.record))
    const items = visible.slice(0, parsed.limit)
    return ListInteractionsResponseSchema.parse({
      items,
      nextCursor: visible.length > parsed.limit ? encodeCursor(items.at(-1)!.id) : null,
    })
  }

  async get(principal: ManagementPrincipal, interactionId: string) {
    const interaction = requireReadableInteraction(principal, await this.interactions.get(interactionId))
    return { interaction }
  }

  async respond(principal: ManagementPrincipal, input: unknown) {
    const parsed = RespondToInteractionRequestSchema.parse(input)
    let current: ReturnType<typeof DurableInteractionSchema.parse> | undefined
    try {
      current = requireRespondableInteraction(principal, await this.interactions.get(parsed.interactionId))
      if (!this.orchestration) throw new DomainError('APPROVAL_RUNTIME_UNAVAILABLE',
        'The current approval decision service is unavailable.', 503)
      const result = await this.orchestration.respond({
        kind: 'orchestrator', principal,
        authority: {
          agentId: principal.agentId!, workspaceId: current.workspaceId, workflowId: current.workflowId,
        },
      }, parsed)
      return RespondToInteractionResponseSchema.parse(result)
    } catch (error) {
      const denied = error instanceof DomainError && ['INTERACTION_NOT_FOUND', 'INTERACTION_ACCESS_DENIED'].includes(error.code)
      if (denied) {
        await this.commands.recordDenied(principal.id, 'mcp', 'interaction_respond', 'interaction:requested').catch(() => undefined)
      } else {
        await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond',
          `interaction:${current?.id ?? parsed.interactionId}`, 'failed', {
            code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
          }).catch(() => undefined)
      }
      throw error
    }
  }
}
