import {
  IdSchema,
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  DurableInteractionSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
} from '@graphql/contracts'
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
    if (!hasWorkerAction(principal, 'interactions:respond')) return false
    const scope = workerScope(principal)
    const result = await this.pool.query<{ record: unknown }>(
      `select record from runs
       where ($1::text[] is null or workspace_id = any($1))
         and ($2::text[] is null or workflow_id = any($2))
         and ($3::text[] is null or id = any($3))
         and record->'approval'->>'handler' = 'orchestrator'
         and record->'approval'->>'designatedOrchestratorAgentId' = $4
       limit 1`,
      [scope.workspaceIds ?? null, scope.workflowIds ?? null, scope.runIds ?? null, principal.agentId],
    )
    return result.rowCount === 1
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
      const result = this.orchestration
        ? await this.orchestration.respond({
            kind: 'orchestrator', principal,
            authority: {
              agentId: principal.agentId!, workspaceId: current.workspaceId, workflowId: current.workflowId,
            },
            beforeCommit: (client, decision) => this.commands.recordAudit(
              principal.id, 'mcp', 'interaction_respond', `interaction:${current!.id}`, 'succeeded',
              { replayed: decision.replayed, optionId: parsed.optionId }, client,
            ),
          }, parsed)
        : await this.interactions.decide({
            id: parsed.interactionId, optionId: parsed.optionId, expectedRevision: parsed.expectedRevision,
            nativeResponse: null, principal,
            beforeCommit: (client, decision) => this.commands.recordAudit(
              principal.id, 'mcp', 'interaction_respond', `interaction:${current!.id}`, 'succeeded',
              { replayed: decision.replayed, optionId: parsed.optionId }, client,
            ),
          })
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
