import { afterEach, describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

/** Real review failure and Stop producers; no seeded native acknowledgement,
 * no provider process, no synthetic checkpoint consumer, no closure claim. */
describe.skipIf(!postgresEnabled)('BR1-004: approval failure lifecycle publication', () => {
  it('replays actual review-failure Stop and cannot hide review cleanup by clearing only the Run intent', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
      throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    }
    const f = await approvalDatabase(); closes.push(f.close)
    const { compare } = await graphParity(f.pool, f.scope)
    const initial = await compare()
    expect(initial.state.nodes.find((node) => node.state.workflowNodeId === f.reviewer.workflowNodeId)!.state.lifecycle).toBe('succeeded')
    await f.repository.coordination.transitionReviewJob(f.job.id, f.job.leaseToken!, 'failed', {
      error: { code: 'SYNTHETIC_REVIEW_LOSS', message: 'Review loss without a native closure claim.' },
    })
    const failed = await compare()
    expect(failed.state.run.stopRequested).toBe(true)
    expect(failed.state.run.cleanupPending).toBe(true)
    expect(failed.state.run.unsettledReviewCount).toBe(1)
    expect(failed.state.nodes.every((node) => node.activity.status === 'none')).toBe(true)
    expect(failed.state.nodes.find((node) => node.state.workflowNodeId === f.reviewer.workflowNodeId)!.state.lifecycle).toBe('succeeded')
    expect(failed.state.reviews.find((review) => review.reviewJobId === f.job.id)?.state).toBe('failed')
    expect((await f.pool.query('select stop_cause from runs where id=$1', [f.run.id])).rows[0].stop_cause.kind).toBe('review_failure')
    const owner = await f.runs.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Expected Run owner')
    try {
      await expect(f.runs.finishCleanup(f.run.id, false, owner)).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    } finally { await owner.release() }
    const stillUnsettled = await compare()
    expect(stillUnsettled.state.run.cleanupPending).toBe(true)
    expect(stillUnsettled.state.nodes.find((node) => node.state.workflowNodeId === f.reviewer.workflowNodeId)!.attention.cleanupPending).toBe(true)
  }, 30000)
})
