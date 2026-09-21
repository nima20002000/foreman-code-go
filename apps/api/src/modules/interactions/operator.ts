import type { DurableInteraction } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { InteractionService } from './service.js'
import type { PostgresInteractionRepository } from './postgres.js'

export function operatorResponseAccess(principal: ManagementPrincipal, interaction: DurableInteraction) {
  const authorized = interaction.approval.handler === 'operator' && isAuthorized(principal, 'interactions:respond', {
    workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
  })
  return {
    canRespond: authorized && interaction.status === 'pending',
    canRetryDelivery: authorized && Boolean(interaction.selectedOptionId)
      && ['decided', 'delivery_pending', 'delivery_failed'].includes(interaction.status),
    handler: interaction.approval.handler,
  }
}

type ListInput = {
  workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
  handler?: DurableInteraction['approval']['handler'] | undefined;
  status?: DurableInteraction['status'] | undefined; cursor?: string | undefined; limit: number;
}
export class OperatorInteractionService {
  constructor(private readonly service: InteractionService, private readonly repository: PostgresInteractionRepository) {}

  async list(principal: ManagementPrincipal, input: ListInput) {
    // The repository filters grants before LIMIT, including an omitted scope and
    // run-only grants. Reading a different handler never authorizes its response.
    const page = await this.service.listVisible(principal, input)
    return {
      items: page.items, pageInfo: { nextCursor: page.nextCursor },
      pendingCount: page.pendingCount, pendingByWorkflow: page.pendingByWorkflow,
      responseAccess: Object.fromEntries(page.items.map((item) => [item.id, operatorResponseAccess(principal, item)])),
    }
  }
  async summary(principal: ManagementPrincipal, input: Omit<ListInput,'status'|'cursor'|'limit'>) {
    const page = await this.service.listVisible(principal, {...input, limit: 1, status: 'pending'})
    return {pendingCount: page.pendingCount, pendingByWorkflow: page.pendingByWorkflow}
  }
  async get(principal: ManagementPrincipal, interactionId: string) {
    const detail = await this.service.reviewStatusVisible(principal, interactionId)
    return {...detail, ...operatorResponseAccess(principal, detail.interaction)}
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
    const result = await this.service.respond({kind: 'operator', principal}, input)
    return {value: result.interaction, replayed: result.replayed}
  }
}
