import {
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  DurableInteractionSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'

import { workerScope, canReadInteraction, hasWorkerAction, requireReadableInteraction, requireRespondableInteraction } from '../access/appPolicy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { PostgresInteractionRepository } from './postgres.js'
import type { InteractionService } from './service.js'

const CURSOR_PREFIX = 'interaction:'
export const AppInteractionListInputSchema = ListInteractionsRequestSchema.pick({ cursor: true, limit: true }).strict()

function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!decoded.startsWith(CURSOR_PREFIX) || decoded.length === CURSOR_PREFIX.length) throw new Error('invalid')
    return decoded.slice(CURSOR_PREFIX.length)
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
    const scope = workerScope(principal)
    const afterId = decodeCursor(parsed.cursor)
    const rows = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions
       where status = 'pending'
         and ($1::text[] is null or workspace_id = any($1))
         and ($2::text[] is null or workflow_id = any($2))
         and ($3::text[] is null or run_id = any($3))
         and ($4::text is null or id > $4)
       order by id limit $5`,
      [scope.workspaceIds ?? null, scope.workflowIds ?? null, scope.runIds ?? null, afterId ?? null, parsed.limit + 1],
    )
    const visible = rows.rows
      .map((row) => requireReadableInteraction(principal, DurableInteractionSchema.parse(row.record)))
      .filter((interaction) => canReadInteraction(principal, interaction))
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
    const current = requireRespondableInteraction(principal, await this.interactions.get(parsed.interactionId))
    if (!this.orchestration) throw new DomainError('INTERACTION_DELIVERY_UNAVAILABLE', 'Native interaction delivery is not configured.', 503)
    try {
      const result = await this.orchestration.respond({
        kind: 'orchestrator',
        authority: {
          agentId: principal.agentId!, workspaceId: current.workspaceId, workflowId: current.workflowId,
        },
      }, parsed)
      await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond', `interaction:${current.id}`, 'succeeded', {
        replayed: result.replayed,
        optionId: parsed.optionId,
      })
      return RespondToInteractionResponseSchema.parse(result)
    } catch (error) {
      await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond', `interaction:${current.id}`, 'failed', {
        code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
      }).catch(() => undefined)
      throw error
    }
  }
}
