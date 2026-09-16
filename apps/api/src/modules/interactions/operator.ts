import type { ManagementPrincipal } from '@graphql/contracts/management'

import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { InteractionService } from './service.js'
import { PostgresInteractionRepository } from './postgres.js'

export class OperatorInteractionService {
  constructor(
    private readonly service: InteractionService,
    private readonly repository: PostgresInteractionRepository,
  ) {}

  async list(principal: ManagementPrincipal, input: {
    workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
    status?: Parameters<InteractionService['list']>[0]['status'] | undefined;
    cursor?: string | undefined; limit: number
  }) {
    const resource = {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    }
    requireAuthorization(principal, 'interactions:read', resource)
    const page = await this.service.list({
      ...resource, handler: 'operator', ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit,
    })
    const items = page.items.filter((item) => isAuthorized(principal, 'interactions:read', {
      workspaceId: item.workspaceId, workflowId: item.workflowId, runId: item.runId,
    }))
    return { items, pageInfo: { nextCursor: page.nextCursor } }
  }

  async get(principal: ManagementPrincipal, interactionId: string) {
    const interaction = await this.service.get(interactionId)
    if (interaction.approval.handler !== 'operator' || !isAuthorized(principal, 'interactions:read', {
      workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
    })) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    return { interaction }
  }

  async respond(principal: ManagementPrincipal, input: {
    interactionId: string; optionId: string; expectedRevision: number; commandId: string
  }) {
    const interaction = await this.repository.get(input.interactionId)
    if (!interaction) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    if (interaction.approval.handler !== 'operator') throw new DomainError('INTERACTION_ACCESS_DENIED', 'The interaction is assigned to a different handler.', 403)
    requireAuthorization(principal, 'interactions:respond', {
      workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
    })
    // The authorized service binds the receipt in the same transaction as the
    // decision. No receipt exists for an invalid option, stale revision, or denial.
    const result = await this.service.respond({ kind: 'operator', principal }, input)
    return { value: result.interaction, replayed: result.replayed }
  }
}
