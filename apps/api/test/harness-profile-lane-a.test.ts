import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { it } from 'vitest'
import type { CodexHarnessConfiguration, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'

import { codexChatFileDeclarations } from '../src/modules/harnesses/codexFiles/declarations.js'
import { forgetQualifiedProfile, rememberQualifiedProfile } from '../src/modules/harnesses/qualification/profiles.js'
import { reviewOwnsPermission } from '../src/modules/interactions/reviewerCleanup.js'
import { ReviewEvidenceTracker } from '../src/modules/interactions/reviewerEvidence.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

it('qualified Codex versions use the newest file declaration profile; unknown versions fail closed', async () => {
  const version = 'codex-cli 0.158.0'
  const configuration = { sandbox: 'read-only' } as CodexHarnessConfiguration
  assert.throws(() => codexChatFileDeclarations(configuration, version), /qualified native dynamic-tool schema/)
  assert.throws(() => new DeterministicNativeSessionManager('codex', version), /FIXTURE_PROVIDER_UNQUALIFIED/)
  rememberQualifiedProfile('codex', version, 'codex-0.156')
  try {
    assert.deepEqual(codexChatFileDeclarations(configuration, version),
      codexChatFileDeclarations(configuration, 'codex-cli 0.156.1'))
    assert.equal((await new DeterministicNativeSessionManager('codex', version).capabilities()).providerVersion, version)
  } finally { forgetQualifiedProfile('codex', version) }
})

it('qualified OpenCode versions retain reviewer message and permission lineage; unknown versions fail closed', () => {
  const version = '1.18.33'
  const correlation = 'profile-review'
  const messageId = `msg_${createHash('sha256').update(correlation).digest('hex').slice(0, 24)}`
  const session: NativeSessionReference = { harness: 'opencode', providerVersion: version, nativeSessionId: 'ses_profile' }
  const request: PendingNativeInteraction = { session, turn: { nativeTurnId: 'assistant-tool', nativeRequestId: 'permission' },
    nativeRequestType: 'permission.asked', request: { id: 'permission', sessionID: session.nativeSessionId,
      tool: { messageID: 'assistant-tool', callID: 'call' } }, responseOptions: [] }
  const history = { events: [{ sequence: 0, type: 'message.updated', occurredAt: '2026-09-28T00:00:00.000Z',
    payload: { info: { id: 'assistant-tool', sessionID: session.nativeSessionId, role: 'assistant', parentID: messageId } } }],
    pendingInteractions: [request] }
  assert.equal(reviewOwnsPermission(session, messageId, request, history), false)
  assert.equal(new ReviewEvidenceTracker(session, correlation, messageId).snapshot().identityConflict, true)
  rememberQualifiedProfile('opencode', version, 'opencode-1.18.31')
  try {
    assert.equal(reviewOwnsPermission(session, messageId, request, history), true)
    assert.equal(new ReviewEvidenceTracker(session, correlation, messageId).snapshot().identityConflict, undefined)
  } finally { forgetQualifiedProfile('opencode', version) }
})
