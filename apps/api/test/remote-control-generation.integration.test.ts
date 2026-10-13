import { expect, it } from 'vitest'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

it('persists generation-zero remote admission and keeps its original snapshot immutable', async () => {
  const f = await approvalDatabase()
  try {
    const interaction = f.interaction
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
      commandId: 'original-response', operationId: 'original-operation', attemptId: 'original-attempt',
      executionId: interaction.executionId, bindingHash: 'a'.repeat(64), owner: { grantId: 'original-grant', epoch: '1' },
      native: { sessionId: interaction.nativeSessionId, turnId: 'original-turn', processIdentityDigest: 'b'.repeat(64) },
      action: { kind: 'respond', interactionId: interaction.id, interactionRevision: String(interaction.revision),
        nativeInteractionId: interaction.nativeRequestId, response: interaction.responseOptions[0] } })
    await f.pool.query(`insert into interaction_delivery_attempts(interaction_id,attempt,state,native_session_id,
      native_request_id,correlation_id,remote_owner_control,remote_owner_control_token,
      remote_owner_control_fence,remote_owner_control_generation)
      values($1,1,'submitted',$2,$3,'original-correlation',$4::jsonb,'original-owner',1,0)`,
    [interaction.id, interaction.nativeSessionId, interaction.nativeRequestId, JSON.stringify(command)])
    const stored = (await f.pool.query(`select remote_owner_control,remote_owner_control_generation::text as generation
      from interaction_delivery_attempts where interaction_id=$1`, [interaction.id])).rows
    expect(stored).toEqual([{ remote_owner_control: command, generation: '0' }])
    await expect(f.pool.query(`update interaction_delivery_attempts set remote_owner_control_generation=1
      where interaction_id=$1`, [interaction.id])).rejects.toThrow('immutable')
    const unchanged = (await f.pool.query(`select remote_owner_control,remote_owner_control_generation::text as generation
      from interaction_delivery_attempts where interaction_id=$1`, [interaction.id])).rows
    expect(unchanged).toEqual([{ remote_owner_control: command, generation: '0' }])
    await expect(f.pool.query(`delete from interaction_delivery_attempts where interaction_id=$1`,
      [interaction.id])).rejects.toThrow('retained')
    await expect(f.pool.query(`insert into interaction_delivery_attempts(interaction_id,attempt,state,native_session_id,
      native_request_id,correlation_id,remote_owner_control,remote_owner_control_token,
      remote_owner_control_fence,remote_owner_control_generation)
      values($1,2,'submitted',$2,$3,'other-correlation',$4::jsonb,'original-owner',1,-1)`,
    [interaction.id, interaction.nativeSessionId, interaction.nativeRequestId, JSON.stringify(command)]))
      .rejects.toMatchObject({ code: '23514' })
  } finally { await f.close() }
}, 30_000)
