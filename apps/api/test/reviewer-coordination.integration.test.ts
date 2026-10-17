import type { ReviewJob } from '@foreman-code/contracts'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

afterEach(() => vi.restoreAllMocks())

async function expire(f: Awaited<ReturnType<typeof routedApprovalFixture>>, job: ReviewJob,
  field: 'leaseExpiresAt' | 'retryAfter') {
  await f.db.pool.query(`update review_jobs set record=jsonb_set(record, $2::text[],
    to_jsonb(to_char((clock_timestamp() - interval '1 second') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) where id=$1`, [job.id, [field]])
}

async function contenders(f: Awaited<ReturnType<typeof routedApprovalFixture>>) {
  const claims = await Promise.allSettled(['first', 'second'].map(owner =>
    f.coordination.claimReviewJob(f.job.id, owner, `${owner}-token`,
      new Date(Date.now() + 60_000).toISOString())))
  const winners = claims.filter(result => result.status === 'fulfilled')
  expect(winners).toHaveLength(1)
  expect(claims.filter(result => result.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining({ code: 'REVIEW_JOB_NOT_CLAIMABLE' }) }),
  ])
  const winner = winners[0]!.value
  expect(winner.leaseToken).toBe(`${winner.leaseOwner}-token`)
  expect(await f.coordination.findReviewJob(f.job.interactionId, f.reviewerId)).toEqual(winner)
  return winner
}

describe.skipIf(!postgresEnabled)('review queue eligibility with persisted leases', () => {
  it('excludes a live lease, selects an expired lease, and persists only one competing claim', async () => {
    const f = await routedApprovalFixture()
    try {
      const original = await f.coordination.claimReviewJob(f.job.id, 'original', 'original-token',
        new Date(Date.now() + 60_000).toISOString())
      expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
      expect(await f.coordination.reviewJobAgents()).not.toContain(f.reviewerId)
      await expect(f.coordination.claimReviewJob(f.job.id, 'early', 'early-token',
        new Date(Date.now() + 60_000).toISOString())).rejects.toMatchObject({ code: 'REVIEW_JOB_NOT_CLAIMABLE' })
      expect(await f.coordination.findReviewJob(f.job.interactionId, f.reviewerId)).toEqual(original)
      await expire(f, original, 'leaseExpiresAt')
      expect(await f.coordination.nextReviewJob(f.reviewerId)).toMatchObject({ id: f.job.id })
      expect(await f.coordination.reviewJobAgents()).toContain(f.reviewerId)
      const winner = await contenders(f)
      expect(winner).toMatchObject({
        state: 'leased', attempt: original.attempt + 1,
        provider: original.provider, nativeSessionId: original.nativeSessionId, correlationId: original.correlationId,
      })
    } finally {
      await f.close()
    }
  })

  it('delays failed cleanup until retry expiry and preserves the failure and cleanup when reclaimed', async () => {
    const f = await routedApprovalFixture()
    try {
      await f.coordination.claimReviewJob(f.job.id, 'original', 'original-token',
        new Date(Date.now() + 60_000).toISOString())
      const failed = await f.coordination.transitionReviewJob(f.job.id, 'original-token', 'failed', {
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        error: { code: 'ORIGINAL_FAILURE', message: 'Keep the business failure.' },
      })
      expect(failed.cleanup).toEqual({
        nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent',
      })
      expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
      expect(await f.coordination.reviewJobAgents()).not.toContain(f.reviewerId)
      await expect(f.coordination.claimReviewJob(f.job.id, 'early', 'early-token',
        new Date(Date.now() + 60_000).toISOString())).rejects.toMatchObject({ code: 'REVIEW_JOB_NOT_CLAIMABLE' })
      await expire(f, failed, 'retryAfter')
      expect(await f.coordination.nextReviewJob(f.reviewerId)).toMatchObject({ id: failed.id })
      expect(await f.coordination.reviewJobAgents()).toContain(f.reviewerId)
      expect(await contenders(f)).toMatchObject({ state: 'failed', cleanup: failed.cleanup, error: failed.error })
    } finally {
      await f.close()
    }
  })
})
