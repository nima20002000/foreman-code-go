import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
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
      await delay(Math.max(0, Date.parse(blocked!.retryAfter!) - Date.now() + 50))
      const claims = await Promise.allSettled(['first', 'second'].map((owner) => f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`, new Date(Date.now() + 60000).toISOString())))
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1)
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
