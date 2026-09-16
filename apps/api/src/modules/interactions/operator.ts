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
    const commandReplayed = await this.repository.bindCommand({
      principalId: principal.id, commandId: input.commandId,
      interactionId: input.interactionId, optionId: input.optionId,
    })
    const result = await this.service.respond({ kind: 'operator', principal }, input)
    return { value: result.interaction, replayed: commandReplayed || result.replayed }
  }
}
