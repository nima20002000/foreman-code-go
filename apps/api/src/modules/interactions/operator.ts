import type { DurableInteraction } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { InteractionService } from './service.js'

type ListInput = {
  workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
  handler?: DurableInteraction['approval']['handler'] | undefined;
  status?: DurableInteraction['status'] | undefined; cursor?: string | undefined; limit: number;
}
export class OperatorInteractionService {
  constructor(private readonly service: InteractionService) {}

  async list(principal: ManagementPrincipal, input: ListInput) {
    // The repository filters grants before LIMIT, including an omitted scope and
    // run-only grants. Reading a different handler never authorizes its response.
    const page = await this.service.listVisible(principal, input)
    return {
      items: page.items, pageInfo: { nextCursor: page.nextCursor },
      pendingCount: page.pendingCount, pendingByWorkflow: page.pendingByWorkflow,
    }
  }
  async summary(principal: ManagementPrincipal, input: Omit<ListInput,'status'|'cursor'|'limit'>) {
    const page = await this.service.listVisible(principal, {...input, limit: 1, status: 'pending'})
    return {pendingCount: page.pendingCount, pendingByWorkflow: page.pendingByWorkflow}
  }
  async get(principal: ManagementPrincipal, interactionId: string) {
    return this.service.reviewStatusVisible(principal, interactionId)
  }
}
