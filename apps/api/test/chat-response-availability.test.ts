import { expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type PendingNativeInteraction } from '@graphql/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { nativeInteractionAvailability } from '../src/modules/conversations/interactionAvailability.js'
const interaction = NATIVE_INTERACTION_FIXTURES.codex
const pending: PendingNativeInteraction = { session: { harness: interaction.harness, nativeSessionId: interaction.nativeSessionId,
  providerVersion: interaction.providerVersion }, turn: { nativeTurnId: 'turn', nativeRequestId: interaction.nativeRequestId },
  nativeRequestType: interaction.nativeRequestType, request: interaction.request, responseOptions: interaction.responseOptions }
it('shows actionable restart unavailability without probing/attaching replacement work', async () => {
  const unavailable = await nativeInteractionAvailability(pending, true, undefined, { isCurrent: () => true })
  expect(unavailable).toMatchObject({ available: false, status: 'recovery_required', reason: 'callback_lost', path: null })
  expect(unavailable.message).toContain('do not resubmit')
})
it('requires exact qualified live identity and response permission independently of pending state', async () => {
  const inspect = vi.fn(async () => ({ nativeSessionId: pending.session.nativeSessionId, nativeRequestId: interaction.nativeRequestId,
    nativeRequestType: pending.nativeRequestType, nativeTurnId: pending.turn.nativeTurnId, generation: 'current', qualified: true,
    state: 'available' as const, path: 'live_callback' as const, reason: 'live_callback' as const }))
  const manager = { inspectResponseAvailability: inspect } as unknown as NativeHarnessSessionManager
  const runtime = { manager, session: pending.session }
  expect((await nativeInteractionAvailability(pending, false, runtime, { isCurrent: () => true })).reason).toBe('unauthorized')
  expect(inspect).not.toHaveBeenCalled()
  expect((await nativeInteractionAvailability(pending, true, runtime, { isCurrent: () => true })).available).toBe(true)
  expect((await nativeInteractionAvailability(pending, true, runtime, { isCurrent: () => false })).available).toBe(false)
  expect((await nativeInteractionAvailability({ ...pending, turn: { nativeTurnId: 'turn' } }, true, runtime,
    { isCurrent: () => true })).reason).toBe('missing_request_identity')
})
