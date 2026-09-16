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

import { workerScope, workerScopesForAction, hasWorkerAction, requireReadableInteraction } from '../access/appPolicy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { PostgresInteractionRepository } from './postgres.js'

const CURSOR_PREFIX = 'interaction:'
export const AppInteractionListInputSchema = ListInteractionsRequestSchema.pick({ cursor: true, limit: true }).strict()

function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url')
}

export function decodeInteractionCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid')
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error('invalid')
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!decoded.startsWith(CURSOR_PREFIX)) throw new Error('invalid')
    const id = decoded.slice(CURSOR_PREFIX.length)
    if (IdSchema.parse(id) !== id || [...id].some((character) => {
      const code = character.codePointAt(0)!
      return code < 32 || (code >= 127 && code <= 159)
    })) throw new Error('invalid')
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
  ) {}

  async context(principal: ManagementPrincipal) {
    const scope = workerScope(principal)
    const readAllowed = await this.canRead(principal)
    const responseAllowed = await this.canRespond(principal)
    return {
      principal: { id: principal.id, audience: 'worker' as const, agentId: principal.agentId!, expiresAt: principal.expiresAt },
      scope,
      capabilities: { contextGet: true, interactionList: readAllowed, interactionGet: readAllowed, interactionRespond: responseAllowed },
    }
  }

  async canRead(principal: ManagementPrincipal): Promise<boolean> {
    workerScope(principal)
    return hasWorkerAction(principal, 'interactions:read')
  }

  async canRespond(principal: ManagementPrincipal): Promise<boolean> {
    if (!hasWorkerAction(principal, 'interactions:respond') || !hasWorkerAction(principal, 'interactions:read')) return false
    const result = await this.pool.query(
      `select 1 from runs r
       where r.execution_state in ('running','waiting') and r.worker_credentials_closed_at is null
         and exists (select 1 from jsonb_array_elements($1::jsonb) g
           where g->'workspaceIds' ? r.workspace_id and g->'workflowIds' ? r.workflow_id and g->'runIds' ? r.id)
         and exists (select 1 from jsonb_array_elements($2::jsonb) g
           where g->'workspaceIds' ? r.workspace_id and g->'workflowIds' ? r.workflow_id and g->'runIds' ? r.id)
         and r.record->'approval'->>'handler' = 'orchestrator'
         and r.record->'approval'->>'designatedOrchestratorAgentId' = $3
       limit 1`,
      [JSON.stringify(workerScopesForAction(principal, 'interactions:respond')),
        JSON.stringify(workerScopesForAction(principal, 'interactions:read')), principal.agentId],
    )
    return result.rowCount === 1
  }

  async list(principal: ManagementPrincipal, input: unknown) {
    const parsed = AppInteractionListInputSchema.parse(input)
    workerScope(principal)
    const afterId = decodeInteractionCursor(parsed.cursor)
    // Apply complete per-grant authorization BEFORE pagination. Filtering a
    // unioned page afterward can both leak scopes and skip authorized records.
    const rows = await this.pool.query<{ record: unknown }>(
      `select record from durable_interactions di
       where status = 'pending'
         and exists (select 1 from jsonb_array_elements($1::jsonb) g
           where g->'workspaceIds' ? di.workspace_id and g->'workflowIds' ? di.workflow_id and g->'runIds' ? di.run_id)
         and ($2::text is null or id > $2)
       order by id limit $3`,
      [JSON.stringify(workerScopesForAction(principal, 'interactions:read')), afterId ?? null, parsed.limit + 1],
    )
    const visible = rows.rows.map((row) => requireReadableInteraction(principal, DurableInteractionSchema.parse(row.record)))
    const items = visible.slice(0, parsed.limit)
    return ListInteractionsResponseSchema.parse({ items, nextCursor: visible.length > parsed.limit ? encodeCursor(items.at(-1)!.id) : null })
  }

  async get(principal: ManagementPrincipal, interactionId: string) {
    return { interaction: requireReadableInteraction(principal, await this.interactions.get(interactionId)) }
  }

  async respond(principal: ManagementPrincipal, input: unknown) {
    try {
      const parsed = RespondToInteractionRequestSchema.parse(input)
      return await this.interactions.decide({
        id: parsed.interactionId, optionId: parsed.optionId, expectedRevision: parsed.expectedRevision,
        // The repository derives the exact response from the locked option.
        nativeResponse: null, principal, auditReference: `principal:${principal.id}`,
        beforeCommit: async (client, result) => {
          RespondToInteractionResponseSchema.parse(result)
          await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond', `interaction:${result.interaction.id}`, 'succeeded', {
            replayed: result.replayed, optionId: parsed.optionId,
          }, client)
        },
      })
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'INVALID_OR_FAILED_DECISION'
      // Never persist arbitrary model input or distinguish an out-of-scope ID.
      if (code === 'INTERACTION_NOT_FOUND' || code.startsWith('AUTH_')) {
        await this.commands.recordDenied(principal.id, 'mcp', 'interaction_respond', 'interaction:requested').catch(() => undefined)
      } else {
        await this.commands.recordAudit(principal.id, 'mcp', 'interaction_respond', 'interaction:requested',
          code === 'INTERACTION_DECISION_STATUS_UNKNOWN' ? 'uncertain' : 'failed', { code }).catch(() => undefined)
      }
      throw error
    }
  }
}
