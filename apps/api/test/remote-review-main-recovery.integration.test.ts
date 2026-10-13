import { describe, expect, it } from 'vitest'
import { deliveredReview, retainedReviewRecovery, reviewInProgress, useRemoteReviewFixture,
  waitForRemoteReview } from './helpers/remoteReviewProductionCases.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { graphFixture, ownedGraph } from './eng04-graph-composition-fixture.js'
import { repeatNativePending, REPEAT_NATIVE_PENDING_MESSAGE } from '../src/modules/interactions/repeatNativeEvidence.js'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { graphSourceDigest, openRunGraphPublication } from '../src/modules/run-graph/publication.js'

it('keeps pending native settlement retryable and rolls back the incomplete Run publication', async () => {
  const db = await currentDatabase()
  try {
    const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true })
    try {
      const before = await fixture.repeat.snapshot(fixture.writer.principal, fixture.readRequest)
      await expect(ownedGraph(db, fixture, owner => owner.oneShotConnection().transaction(async sql => {
        const publication = await openRunGraphPublication(sql, fixture.scope, readPublicProjectionLocked)
        await publication.repeatChange({
          evidence: { sourceKind: 'run', sourceId: 'pending-native-completion', sourceRevision: '1' },
          sourceDigest: graphSourceDigest('pending-native-completion'),
          effect: null,
        }, owner, async transaction => {
          await transaction.query(`update runs set execution_state='running',
            record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [fixture.run.id])
          repeatNativePending()
        }, async () => [{ type: 'repeat.run.state', state: before.state.run }])
      }))).rejects.toMatchObject({
        name: 'DomainError', code: 'REPEAT_CLEANUP_PENDING', message: REPEAT_NATIVE_PENDING_MESSAGE, status: 409,
      })
      expect(await fixture.repeat.snapshot(fixture.writer.principal, fixture.readRequest)).toEqual(before)
    } finally {
      await fixture.app.close()
    }
  } finally {
    await db.close()
  }
}, 60_000)

describe('production remote review completion', () => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it('finishes the last response and releases the idle retained reviewer before Run completion', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      await fixture.provider.releaseReview()
      await deliveredReview(fixture, active.interaction.id)
      await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return fixture.executions(active.run.id)
      }, executions => executions.every(execution => execution.state === 'completed'), 'completed workflow executions')
      await fixture.reconcile()
      const settled = await fixture.details(active.run.id)
      expect(settled.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(settled.cleanupPending).not.toBe(true)
      expect(fixture.registry.snapshot().launches.filter(launch => active.owners.some(owner =>
        owner.launchId === launch.launchId)).every(launch => launch.lifecycle !== 'active')).toBe(true)
    })
  }, 60_000)
})

describe.each(['graceful', 'expired-receipt'] as const)('production remote review after %s Main recovery', recovery => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it('continues the original retained review with the Worker alive', async () => {
    await withRemoteReviewFixture(fixture => retainedReviewRecovery(fixture, recovery))
  }, 120_000)
})
