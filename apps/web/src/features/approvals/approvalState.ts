import type { DurableInteraction } from '@graphql/contracts'

export function interactionMatchesScope(interaction: DurableInteraction, scope: { workspaceId?: string; workflowId?: string }): boolean {
  return (!scope.workspaceId || interaction.workspaceId === scope.workspaceId)
    && (!scope.workflowId || interaction.workflowId === scope.workflowId)
}

export function canRecoverInteraction(interaction: DurableInteraction): boolean {
  return interaction.approval.handler === 'user' && Boolean(interaction.selectedOptionId)
    && interaction.status !== 'canceled' && interaction.status !== 'delivered'
    && interaction.deliveryState !== 'delivered'
    && interaction.responseOptions.some((option) => option.optionId === interaction.selectedOptionId)
}
