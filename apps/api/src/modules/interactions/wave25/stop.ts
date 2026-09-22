import { ReviewJobSchema, RunStopCauseSchema, type ReviewJob } from '@graphql/contracts'
import { WorkflowRunV2Schema, type GraphEffect } from '@graphql/contracts/wave25'
import { graphSourceDigest, type RunGraphPublication } from '../../run-graph/publication.js'
import { publicReviewStopError } from '../reviewPolicy.js'
import { fail, type ApprovalContext } from './context.js'

/** Persist a real review failure and Stop intent; the existing Run owner performs
 * native cancellation/credential cleanup. This never schedules or completes work. */
export async function stopForReviewFailure(publication: RunGraphPublication, job: ReviewJob,
  context: ApprovalContext): Promise<void> {
  if (job.state !== 'failed') return
  const sql = publication.sql
  const row = (await sql.query<{ record: unknown; stopped: boolean; stop_cause: unknown }>(
    'select record,stop_requested_at is not null as stopped,stop_cause from runs where id=$1', [context.scope.runId])).rows[0]
  const run = WorkflowRunV2Schema.parse(row?.record)
  if (row?.stopped || run.executionState === 'completed') return
  const saved = (await sql.query<{ record: unknown; revision: string }>(
    'select record,revision::text from review_jobs where id=$1 for update', [job.id])).rows[0]
  const failed = ReviewJobSchema.parse(saved?.record)
  if (!saved || failed.state !== 'failed' || failed.interactionId !== job.interactionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  const cause = row?.stop_cause ?? RunStopCauseSchema.parse({ kind: 'review_failure', interactionId: job.interactionId,
    reviewJobId: job.id, error: publicReviewStopError(job.error?.code), recordedAt: new Date().toISOString() })
  const effect: GraphEffect = { identity: { kind: 'run.stop', entityId: run.id }, digest: graphSourceDigest({ runId: run.id, cause }) }
  const counts = (await sql.query<{ interactions: string; reviews: string }>(`select
    (select count(*)::text from durable_interactions where run_id=$1 and status='pending') as interactions,
    (select count(*)::text from review_jobs j join durable_interactions i on i.id=j.interaction_id
      where i.run_id=$1 and j.state<>'completed' and (j.state<>'failed' or j.record->'cleanup'->>'completedAt' is null)) as reviews`,
  [run.id])).rows[0]!
  await publication.effect({ effect,
    evidence: { sourceKind: 'cleanup', sourceId: `stop:${graphSourceDigest({ job: job.id }).slice(7)}`, sourceRevision: '0' },
    sourceDigest: graphSourceDigest({ failed, cause }), facts: [{ type: 'run.state', state: {
      executionState: run.executionState, outcome: run.outcome, stopRequested: true, cleanupPending: true,
      pendingInteractionCount: Number(counts.interactions), unsettledReviewCount: Number(counts.reviews),
    } }] }, { expected: { scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
      ownerId: job.id, fence: saved.revision, connectionGeneration: null },
    readCurrentLocked: async (transaction) => {
      const current = (await transaction.query<{ id: string; revision: string; state: string }>(
        `select j.id,j.revision::text,j.state from review_jobs j join durable_interactions i on i.id=j.interaction_id
         where j.id=$1 and i.run_id=$2 for update of j`, [job.id, run.id])).rows[0]
      if (!current || current.state !== 'failed') return fail('REVIEW_JOB_IDENTITY_CONFLICT')
      return { scope: context.scope, effect: { kind: 'run.stop', entityId: run.id },
        effectDigest: graphSourceDigest({ runId: run.id, cause }), ownerId: current.id, fence: current.revision,
        connectionGeneration: null, ownership: 'held', access: 'effect', security: 'valid', effectClosed: false, submission: 'settled' }
    } }, async (transaction) => {
    await transaction.query('update runs set stop_cause=coalesce(stop_cause,$2::jsonb),record=record where id=$1', [run.id, JSON.stringify(cause)])
    await transaction.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=clock_timestamp()`, [run.id])
  })
}
