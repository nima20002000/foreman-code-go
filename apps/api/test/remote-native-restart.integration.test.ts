import { describe, expect, it } from 'vitest'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

describe('Production Main restart with unavailable remote native work', () => {
  it.each(['starting', 'waiting'] as const)('records an unresolved %s execution before exiting successfully', async state => {
    const fixture = await remoteReviewProduction({ workflow: state === 'starting' ? 'single' : 'approval' })
    try {
      if (state === 'starting') await fixture.provider.blockModels()
      const started = await fixture.start()
      const execution = await waitForRemoteReview(async () => {
        const executions = await fixture.executions(started.run.id)
        for (const candidate of executions) {
          if (candidate.state !== state) continue
          const lifetime = await fixture.db.pool.query(`select 1 from execution_native_closures
            where execution_id=$1 and closed_at is null and detached_at is null`, [candidate.id])
          if (lifetime.rowCount === 1) return candidate
        }
        return undefined
      }, value => value !== undefined, 'an open native lifetime before Worker disconnect')
      if (!execution) throw new Error('No unresolved remote native execution was admitted.')
      expect(Boolean(execution.nativeSessionId)).toBe(state === 'waiting')
      await fixture.disconnectWorker()
      await fixture.shutdownMain()
      const lifetime = (await fixture.db.pool.query<{
        pending: boolean; closed: boolean; detached: boolean
      }>(`select recovery_requested_at is not null as pending,closed_at is not null as closed,
        detached_at is not null as detached from execution_native_closures
        where execution_id=$1 order by generation desc limit 1`, [execution.id])).rows[0]
      expect(lifetime).toEqual({ pending: true, closed: false, detached: false })
      const current = (await fixture.executions(started.run.id)).find(value => value.id === execution.id)!
      const closures = new PostgresWorkflowClosureStore(fixture.db.pool)
      expect(await closures.read(current)).toBeUndefined()
      expect(await closures.readUnbound(current)).toBeUndefined()
    } finally {
      await fixture.provider.releaseModels()
      await fixture.close()
    }
  }, 240_000)
})
