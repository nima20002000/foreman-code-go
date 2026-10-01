import { expect, it } from 'vitest'
import { activitySnapshotFixtures } from '@graphql/contracts'
import { qualifyChatActivity } from '../src/modules/conversations/qualifiedActivity.js'
import type { NativeInteractionResponseAvailability } from '@graphql/contracts/interaction-activity'
it('qualifies only the exact pending owner and preserves independent recorded evidence', () => {
  const base = structuredClone(activitySnapshotFixtures.activeBeforeNewerQueued)
  const pending = { id: 'persisted-native-source', revision: '7', owner: base.active[0]!.ref,
    native: { harness: 'codex', sessionId: 'session', turnId: 'turn', requestId: 'native-request' },
    delivery: 'pending' as const, answerRecorded: false, providerAcknowledged: false, workerAcknowledged: false,
    responseAvailability: 'unknown' as const }
  const snapshot = { ...base, pendingInteractions: [pending] }
  const response: NativeInteractionResponseAvailability = { nativeSessionId: 'session', nativeTurnId: 'turn',
    nativeRequestId: 'native-request', nativeRequestType: 'approval', available: true, status: 'available', path: 'live_callback',
    generation: 'current', reason: 'live_callback', message: 'Available.' }
  const qualified = qualifyChatActivity(snapshot, response)
  expect(qualified.pendingInteractions[0]).toEqual({ ...pending, responseAvailability: 'available' })
  expect(qualified.active).toEqual(base.active)
  expect(qualified.queued).toEqual(base.queued)
  expect(qualified.revision).toBe(base.revision)
  expect(qualifyChatActivity(snapshot, { ...response, nativeRequestId: 'previous-request' }).pendingInteractions[0]!.responseAvailability).toBe('unavailable')
  expect(qualifyChatActivity(snapshot, { ...response, available: false, status: 'recovery_required', path: null,
    reason: 'callback_lost' }).pendingInteractions[0]!.responseAvailability).toBe('recovery_required')
})
