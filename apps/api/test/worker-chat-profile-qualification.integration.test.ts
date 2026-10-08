import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('uses the selected Worker qualification when the general harness cache has a conflicting record', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'sequential' })
  try {
    const profile = fixture.profiles[0]!
    const row = await fixture.db.pool.query<{ record: unknown }>(`select record
      from harness_instance_profile_evidence where instance_id=$1 order by created_at desc limit 1`,
    [profile.instanceId])
    const proof = HostHarnessProfileEvidenceSchema.parse(row.rows[0]!.record)
    const native = proof.completedNativeQualification!.record
    if (native.version === null || native.binarySha256 === null) {
      throw new Error('Expected a completed Worker qualification version and binary fingerprint')
    }
    const qualifications = new HarnessQualificationRepository(fixture.db.pool)
    await qualifications.save({ ...native, status: 'failed', failureReason: 'Another host failed its native check.' })
    expect((await qualifications.find(native.harness, native.version, native.binarySha256,
      native.suiteRevision))?.status).toBe('failed')
    expect(await qualifications.findInstalled(profile.target, native.binarySha256, native.suiteRevision))
      .toEqual([native])

    const node = fixture.version.definition.nodes[0]!
    if (!('agentId' in node)) throw new Error('Agent chat requires an Agent fixture node')
    const workspaceId = fixture.version.workspaceId
    const context = { workflowId: fixture.version.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const reader = await fixture.access.issue({ name: 'Worker chat read-only caller', audience: 'operator',
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId] } }],
      expiresAt: new Date(Date.now() + 600_000) })
    const request = { requestId: randomUUID(), content: 'Reply with ACK.', intent: 'next_turn',
      expectedConversationId: null, context }
    const denied = await fixture.call('agent_chat_send', { workspaceId, request }, reader.token)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    await fixture.value('agent_chat_send', { workspaceId, request })
    const state = await waitForRemoteReview(async () => AgentChatStateSchema.parse(await fixture.value(
      'agent_chat_read', { workspaceId, query: context })), value =>
      Boolean(value.conversation?.nativeSession) && value.turns.some(turn =>
        turn.requestId === request.requestId && turn.nativeTurnId !== undefined),
    'selected Worker chat submission')
    expect(state.conversation?.nativeSession?.nativeSessionId).toBeTruthy()
    const turn = state.turns.find(turn => turn.requestId === request.requestId)!
    expect(turn.nativeTurnId).toBeTruthy()
    const readback = AgentChatStateSchema.parse(await fixture.value('agent_chat_read',
      { workspaceId, query: context }))
    expect(readback.conversation?.id).toBe(state.conversation?.id)
    expect(readback.messages.find(message => message.id === turn.messageId))
      .toMatchObject({ role: 'user', content: request.content })
    const persisted = await fixture.db.pool.query<{ native_session_id: string | null }>(
      'select native_session_id from operator_conversations where id=$1', [state.conversation!.id])
    expect(persisted.rows[0]?.native_session_id).toBe(state.conversation?.nativeSession?.nativeSessionId)
  } finally {
    await fixture.close()
  }
}, 240_000)
