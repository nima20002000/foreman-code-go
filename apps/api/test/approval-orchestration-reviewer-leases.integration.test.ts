import { afterEach, describe, expect, it, vi } from 'vitest'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { retainRemoteReviewerCredential } from '../src/modules/interactions/retainedRemoteReviewer.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  it('releases a drained review observer without changing its acknowledged native turn', async () => {
    const f = await approvalDatabase()
    try {
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, 'completed', {
        releaseLease: true,
      })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, 'acknowledged', {
        releaseLease: true, retryAfter: new Date().toISOString(),
      })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
      f.resumeObservation()
      await f.native.reviewers.shutdown()
      const retained = await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)
      expect(retained).toEqual({
        ...f.job, updatedAt: expect.any(String),
        leaseOwner: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
      })
      expect((await f.repository.coordination.getLane(f.job.provider, f.job.nativeSessionId))?.leaseToken)
        .toBeUndefined()
      const successor = await f.repository.coordination.claimReviewJob(f.job.id, 'successor', 'successor-token',
        new Date(Date.now() + 60_000).toISOString())
      await expect(f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, f.job.state, {
        releaseLease: true,
      })).rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await f.repository.coordination.findReviewJob(f.interaction.id, f.reviewer.agentId)).toEqual(successor)
      const token = f.credential.environment.variables.GRAPHQL_MCP_TOKEN!
      await expect(f.access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const bindingBefore = (await f.pool.query(`select approval_review_job_id,approval_review_lease_fence
        from worker_credential_bindings where principal_id=$1`, [f.principal.id])).rows[0]
      const native = (await f.repository.coordination.workflowSession(f.reviewer.id))!
      await withExclusiveGraphConnection(f.pool, connection => connection.transaction(sql =>
        retainRemoteReviewerCredential(sql, f.reviewer, {
          generation: '1', principalId: f.principal.id, session: native.session,
        })))
      await expect(f.access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const binding = (await f.pool.query(`select approval_review_job_id,approval_review_lease_fence
        from worker_credential_bindings where principal_id=$1`, [f.principal.id])).rows[0]
      expect(binding).toEqual(bindingBefore)
      expect(binding.approval_review_job_id).toBe(f.job.id)
      await f.credentials.bindReviewerJob(f.reviewer.id, f.credential, successor)
      const recovered = await f.access.authenticate(token, 'worker')
      expect(recovered).toEqual(f.principal)
      const app = new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)
      await expect(app.respond(recovered, approvalResponse(f.interaction)))
        .rejects.toMatchObject({ code: 'REVIEWER_AUTHORITY_LOST' })
      expect(await f.repository.get(f.interaction.id)).toEqual(f.interaction)
    } finally {
      await f.close()
    }
  }, 50_000)

  it('keeps a busy reviewer pending and gives exactly one contender its durable job lease', async () => {
    const f = await routedApprovalFixture()
    let busyLaneId: string | undefined
    try {
      const lane = (await f.coordination.getLane('codex', f.reviewer.nativeSessionId!))!
      await f.coordination.claimLane(lane.id, lane.revision, f.reviewerId, 'busy-writer', new Date(Date.now() + 60000).toISOString(), 'active-turn')
      busyLaneId = lane.id
      expect(await f.native.reviewers.dispatchNext(f.reviewerId, 'busy-probe')).toMatchObject({ state: 'blocked_busy' })
      expect(f.counts().prompts).toBe(2)
      const blocked = await f.coordination.findReviewJob(f.job.interactionId, f.reviewerId)
      expect(blocked?.retryAfter).toBeDefined()
      const early = await Promise.allSettled(['early-first', 'early-second'].map((owner) =>
        f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`, new Date(Date.now() + 60000).toISOString())))
      expect(early.every((result) => result.status === 'rejected')).toBe(true)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(blocked!.retryAfter!) + 1)
      try {
        const claims = await Promise.allSettled(['first', 'second'].map((owner) =>
          f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`,
            new Date(Date.now() + 60000).toISOString())))
        expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1)
      } finally { clock.mockRestore() }
    } finally {
      if (busyLaneId) await f.coordination.releaseLane(busyLaneId, 'busy-writer', { observedStatus: 'idle' })
      try {
        await expect(f.engine.shutdown()).resolves.toBeUndefined()
        expect(await f.runs.get(f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
        expect(await f.repository.get(f.interaction.id)).toMatchObject({ status: 'pending' })
        expect(f.counts()).toMatchObject({ prompts: 2, responses: 0 })
      } finally {
        await f.close()
      }
    }
  }, 60000)
})
