import { ReviewJobSchema } from '@graphql/contracts'
import {
  parseNativeGraphObservation, assertNativeGraphProjectionAuthority, sameGraphScope,
  canonicalGraphJson, type NativeGraphObservation,
} from '@graphql/contracts/wave25'
import type { NativeGraphProjectionGuard } from '../../run-graph/records.js'
import type { RunGraphPublication } from '../../run-graph/publication.js'
import { graphSourceDigest } from '../../run-graph/publication.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { fail } from './context.js'

/** A5 supplies a complete normalized observation and its EXISTING locked owner.
 * This consumer does not parse native frames, infer completion or acquire a runtime.
 * Run it in the same publication as A5's source/projection write. */
export async function recordReviewObservation(publication: RunGraphPublication,
  value: NativeGraphObservation, guard: NativeGraphProjectionGuard): Promise<void> {
  const observation = parseNativeGraphObservation(value)
  if (observation.work.workKind !== 'review' || !sameGraphScope(observation.scope, publication.scope)
    || canonicalGraphJson(guard.expected.key) !== canonicalGraphJson(observation.work)
    || guard.expected.connectionGeneration !== observation.connectionGeneration) return fail('GRAPH_SCOPE_MISMATCH')
  const currentAuthority = await guard.readCurrentLocked(publication.sql, publication.scope, observation.work)
  assertNativeGraphProjectionAuthority(guard.expected, currentAuthority)
  const row = (await publication.sql.query<{ record: unknown; execution_id: string; approval_native_evidence: unknown }>(
    'select record,execution_id,approval_native_evidence from review_jobs where id=$1 for update',
    [observation.work.workId])).rows[0]
  const job = ReviewJobSchema.parse(row?.record)
  if (row?.execution_id !== observation.work.execution.executionId || job.id !== observation.work.workId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  // Liveness never overwrites semantic evidence and never creates a turn.
  if (observation.kind === 'transport') return
  if (!job.submittedAt) return fail('GRAPH_EVIDENCE_INVALID')
  if (job.providerTurnOrMessageId && job.providerTurnOrMessageId !== observation.submissionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
  const previous = row?.approval_native_evidence ? parseNativeGraphObservation(row.approval_native_evidence) : undefined
  if (previous && previous.kind !== 'transport') {
    if (previous.submissionId !== observation.submissionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
    if (canonicalGraphJson(previous.source) === canonicalGraphJson(observation.source)) {
      if (canonicalGraphJson(previous) !== canonicalGraphJson(observation)) return fail('GRAPH_SOURCE_CONFLICT')
      return
    }
    if (previous.kind === 'terminal') {
      if (observation.kind !== 'terminal') return
      if (canonicalGraphJson(previous.terminal) !== canonicalGraphJson(observation.terminal)) return fail('GRAPH_TERMINAL_CONFLICT')
      return
    }
    if (observation.kind === 'submission' && previous.kind === 'submission') {
      if (previous.state === 'acknowledged' && observation.state !== 'acknowledged') return
      if (previous.sourceStreamId === observation.sourceStreamId
        && BigInt(observation.sourcePosition) <= BigInt(previous.sourcePosition)) return
    }
  }
  // This bounded internal receipt is evidence, not a second ReviewJob or activity
  // projection. The coordinator publishes a separate durable business transition.
  await publication.sql.query(`update review_jobs set approval_native_evidence=$2::jsonb
    where id=$1`, [job.id, JSON.stringify(observation)])
}

export async function reviewEvidence(sql: GraphTransactionSql, jobId: string): Promise<NativeGraphObservation | undefined> {
  const row = (await sql.query<{ approval_native_evidence: unknown }>(
    'select approval_native_evidence from review_jobs where id=$1', [jobId])).rows[0]
  return row?.approval_native_evidence ? parseNativeGraphObservation(row.approval_native_evidence) : undefined
}
export function acknowledgementId(observation: NativeGraphObservation | undefined): string | undefined {
  return observation && (observation.kind === 'terminal' && observation.terminal.nativeSettled
    || observation.kind === 'submission' && observation.state === 'acknowledged')
    ? `ack:${graphSourceDigest({ work: observation.work, source: observation.source }).slice(7)}` : undefined
}
