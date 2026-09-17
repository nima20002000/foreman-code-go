import type { DurableInteraction, NativeSessionReference } from '@graphql/contracts'
import type { NativeHistory } from '../harnesses/port.js'

/** A lease may expire during attachment, but never authorizes another native send. */
export const INTERACTION_DELIVERY_LEASE_MS = 60_000

export interface InteractionDeliveryClaim {
  interaction: DurableInteraction
  attempt: number
  ownerToken: string
  correlationId: string
  mode: 'submit' | 'reconcile'
}

export interface NativeDeliveryOutcome {
  state: 'delivered' | 'uncertain' | 'failed'
  error?: string
  evidence?: NativeResponseDeliveryEvidence
}

/**
 * Only a qualified adapter may produce these receipts from provider acknowledgements
 * or provider history. Local pending-list eviction and generic terminal events are
 * not evidence. Identity and the exact durable response must survive reconnects.
 */
export interface NativeResponseDeliveryEvidence {
  source: 'provider_acknowledgement' | 'provider_history'
  harness: DurableInteraction['harness']
  providerVersion: string
  nativeSessionId: string
  nativeRequestId: string
  nativeRequestType: string
  optionId: string
  semantic: NonNullable<DurableInteraction['selectedSemantic']>
}

export function matchingDeliveryEvidence(
  interaction: DurableInteraction,
  session: NativeSessionReference,
  history: NativeHistory,
): NativeResponseDeliveryEvidence | undefined {
  if (session.harness !== interaction.harness || session.providerVersion !== interaction.providerVersion
    || session.nativeSessionId !== interaction.nativeSessionId) return undefined
  // Conflicting observations are uncertain even if a receipt is also present.
  const pending = history.pendingInteraction ? [...history.pendingInteractions, history.pendingInteraction] : history.pendingInteractions
  if (pending.some((item) => item.session.harness === interaction.harness
    && item.session.nativeSessionId === interaction.nativeSessionId
    && item.turn.nativeRequestId === interaction.nativeRequestId)) return undefined
  return history.responseDeliveries?.find((proof) =>
    (proof.source === 'provider_acknowledgement' || proof.source === 'provider_history')
    && proof.harness === interaction.harness && proof.providerVersion === interaction.providerVersion
    && proof.nativeSessionId === interaction.nativeSessionId && proof.nativeRequestId === interaction.nativeRequestId
    && proof.nativeRequestType === interaction.nativeRequestType
    && proof.optionId === interaction.selectedOptionId && proof.semantic === interaction.selectedSemantic)
}
