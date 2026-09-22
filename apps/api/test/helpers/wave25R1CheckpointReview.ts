import type { NativeGraphObservation } from '@graphql/contracts/wave25'
import type { approvalDatabase } from './wave25ApprovalDatabase.js'
import { identity, transact } from '../../src/modules/interactions/wave25/context.js'
import { recordReviewObservation } from '../../src/modules/interactions/wave25/nativeEvidence.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import type { NativeGraphProjectionGuard } from '../../src/modules/run-graph/records.js'
type Fixture = Awaited<ReturnType<typeof approvalDatabase>>

/** Directly supplied review observations isolate the CHECKPOINT boundary.
 * This helper is not production callback, native-provider, or BR1-002 evidence.
 * It never substitutes the persisted checkpoint saver or graph.resume receipt.
 */
export async function settleCheckpointFixtureReview(f: Fixture) {
  const work = { execution: identity(f.reviewer), workKind: 'review' as const, workId: f.job.id }
  const row = (await f.pool.query<{ fence: string }>('select lease_fence::text as fence from review_jobs where id=$1', [f.job.id])).rows[0]!
  const guard: NativeGraphProjectionGuard = {
    expected: { scope: f.scope, key: work, ownerId: 'review-owner-token', fence: row.fence, connectionGeneration: '0' },
    readCurrentLocked: async (sql) => {
      const actual = (await sql.query<{ token: string; fence: string; generation: string; held: boolean }>(
        `select j.lease_token as token,j.lease_fence::text as fence,l.record->>'connectionGeneration' as generation,
          j.lease_expires_at>clock_timestamp() as held from review_jobs j join native_session_lanes l
          on l.native_session_id=j.record->>'nativeSessionId' and l.harness=j.record->>'provider'
          where j.id=$1 for update of j,l`, [f.job.id])).rows[0]!
      return { scope: f.scope, key: work, ownerId: actual.token, fence: actual.fence,
        connectionGeneration: actual.generation, ownership: actual.held ? 'held' : 'lost', access: 'project' }
    },
  }
  for (const terminal of [false, true]) {
    const source = { sourceKind: 'native_event' as const, sourceId: `r1-fixture-${terminal ? 'terminal' : 'ack'}`, sourceRevision: '0' }
    const observation: NativeGraphObservation = { scope: f.scope, work, source,
      sourceStreamId: 'r1-fixture-stream', sourcePosition: terminal ? '2' : '1', connectionGeneration: '0',
      observedAt: new Date().toISOString(), ...(terminal ? { kind: 'terminal' as const, submissionId: 'provider-review-turn',
        terminal: { outcome: 'succeeded' as const, evidenceKind: 'provider_terminal' as const, evidenceId: 'r1-fixture-terminal', nativeSettled: true } }
        : { kind: 'submission' as const, submissionId: 'provider-review-turn', state: 'acknowledged' as const }) }
    await transact(f.pool, f.run.id, async (publication) => publication.source({ evidence: source,
      sourceDigest: graphSourceDigest(observation), facts: [{ type: 'node.activity', activity: { workflowNodeId: f.reviewer.workflowNodeId, status: 'none' } }] },
    () => recordReviewObservation(publication, observation, guard)))
    await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', terminal ? 'completed' : 'acknowledged', {
      writerFence: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' },
      providerTurnOrMessageId: 'provider-review-turn', releaseLease: terminal,
    })
  }
}
