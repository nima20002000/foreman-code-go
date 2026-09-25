import type pg from 'pg'
import { AcceptedWorkflowRunV3Schema, RepeatGraphScopeV3Schema,
  type AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'

import { DomainError } from '../errors.js'
import { beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { openRunGraphPublication, readRepeatRunSourceLocked } from '../run-graph/publication.js'
import { publishRepeatRunStateLocked } from '../run-graph/repeatPublication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { AuthorizeOneShotStop } from './oneShotLifecycle.js'
import type { RunOwnership } from './ownership.js'
import type { RunStateUpdate } from './port.js'
import { sameRepeatValue } from './repeatResolution.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'

function scopeOf(run: AcceptedWorkflowRunV3) {
  return RepeatGraphScopeV3Schema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 })
}

/** Discovery is intentionally not FOR SHARE: openRunGraphPublication takes the
 * parent UPDATE lock before the head/children. Upgrading a prior shared parent
 * lock would deadlock two concurrent lifecycle writers. Never initialize a head. */
async function openLifecycle(sql: GraphTransactionSql, runId: string) {
  const found = await sql.query<{ record: unknown }>('select record from runs where id=$1', [runId])
  if (found.rows.length !== 1) throw new DomainError('RUN_NOT_FOUND', 'The exact Run was not found.', 404)
  const discovery = AcceptedWorkflowRunV3Schema.parse(found.rows[0]!.record)
  if (discovery.id !== runId) throw new DomainError('RUN_PIN_CONFLICT', 'Run identity changed during lifecycle discovery.', 409)
  const publication = await openRunGraphPublication(sql, scopeOf(discovery))
  const snapshot = await readAcceptedRepeatRunLocked(sql, runId)
  if (!sameRepeatValue(scopeOf(snapshot.run), publication.scope)) throw new DomainError('RUN_PIN_CONFLICT', 'The locked Run scope differs from its canonical head.', 409)
  return { publication, snapshot }
}

/** A replay verifies an existing complete source, never reconstructs a missing
 * transition or creates a new cleanup intent. The receipt is checked again after
 * G1 finalization, so returning from a producer is not mistaken for COMMIT. */
async function verifyRunReplay(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, stopped: boolean): Promise<void> {
  const scope = scopeOf(run)
  const source = await readRepeatRunSourceLocked(sql, scope)
  if (!source.replayed || source.stopped !== stopped || !sameRepeatValue(source.run, run)) throw new DomainError('GRAPH_SOURCE_CONFLICT', 'The exact persisted Run state has no matching canonical source.', 409)
  requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence: source.evidence,
    sourceDigest: source.sourceDigest, semanticDigest: source.semanticDigest, effect: null })
  beforeGraphCommit(sql, async () => {
    const latest = await readRepeatRunSourceLocked(sql, scope)
    if (!latest.replayed || latest.stopped !== stopped || !sameRepeatValue(latest.run, run)
      || !sameRepeatValue(latest.evidence, source.evidence) || latest.sourceDigest !== source.sourceDigest
      || latest.semanticDigest !== source.semanticDigest) {
      throw new DomainError('GRAPH_SOURCE_CONFLICT', 'Run state changed after exact replay validation.', 409)
    }
  })
}

/** Concrete first owner-state writer. Only queued -> running (or exact running
 * replay) is qualified here. Waiting -> running needs the missing atomic v3
 * approval consumer; terminal writes need selected-work/closure proof. Generic
 * updateState must not silently become either of those authorities. */
export async function markRepeatRunRunning(owner: RunOwnership,
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization'>, input: RunStateUpdate): Promise<void> {
  const update = structuredClone(input)
  if (update.executionState !== 'running' || update.outcome !== 'pending'
    || Object.keys(update).some((key) => !['executionState', 'outcome', 'startedAt'].includes(key))) {
    throw new DomainError('REPEAT_LIFECYCLE_PUBLICATION_REQUIRED', 'Only the first owner running transition is qualified by this writer.', 409)
  }
  owner.assertOwned()
  await owner.oneShotConnection().transaction(async (sql) => {
    const { publication, snapshot } = await openLifecycle(sql, owner.runId)
    const { run } = snapshot
    const fence = await owner.readOneShotFence(sql)
    const authorize = async () => {
      owner.assertOwned()
      // Same accepted authority and revocation locks as the occurrence host. No
      // caller-supplied principal, fresh grant, location or version is accepted.
      await sql.query(`select principal_id from run_authority_principals
        where principal_id=$1 and run_id=$2 for share`, [run.authorizationPrincipalId, run.id])
      await sql.query(`select p.id from management_principals p where p.id=$1
        or p.id=(select owner_principal_id from run_authority_principals where principal_id=$1 and run_id=$2)
        order by p.id for share`, [run.authorizationPrincipalId, run.id])
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId,
        sql as unknown as Pick<pg.PoolClient, 'query'>)
      if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) throw new DomainError('RUN_OWNERSHIP_LOST', 'The exact Run owner changed before lifecycle COMMIT.', 409)
    }
    await authorize()
    beforeGraphCommit(sql, authorize)
    if (snapshot.stopRequested || snapshot.cleanupPending) throw new DomainError('GRAPH_STOP_CONFLICT', 'Stop/cleanup fences block repeat progress.', 409)
    if (run.executionState === 'waiting') throw new DomainError('REPEAT_APPROVAL_RESUME_REQUIRED', 'A waiting Run requires exact atomic approval consumption.', 409)
    if (!['queued', 'running'].includes(run.executionState)) throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'A terminal/interrupted Run cannot be started again.', 409)
    if (run.startedAt !== undefined && update.startedAt !== undefined && run.startedAt !== update.startedAt) {
      throw new DomainError('RUN_PIN_CONFLICT', 'The original Run start timestamp cannot be replaced.', 409)
    }
    if (run.executionState === 'running') {
      if (!run.startedAt) throw new DomainError('RUN_PIN_CONFLICT', 'A running Run has no original start timestamp.', 409)
      await verifyRunReplay(sql, run, snapshot.stopRequested)
      return
    }
    const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'running', outcome: 'pending',
      startedAt: run.startedAt ?? update.startedAt ?? new Date().toISOString() })
    const changed = await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [run.id, next.executionState, JSON.stringify(next)])
    if (changed.rowCount !== 1) throw new DomainError('RUN_NOT_FOUND', 'The owned Run disappeared during lifecycle publication.', 409)
    await publishRepeatRunStateLocked(publication, owner)
  })
}

/** Authorized Stop only. This commits the parent fence and cleanup intent plus
 * the actual persisted v3 Run source in ONE G1 transaction. It does not cancel a
 * provider, terminalize an execution, issue a command receipt, or assert closure.
 * The management command retains its exact command identity and live policy. */
export async function requestRepeatRunStop(pool: pg.Pool, runId: string, authorize: AuthorizeOneShotStop): Promise<void> {
  if (typeof authorize !== 'function') throw new DomainError('REPEAT_STOP_AUTHORIZATION_REQUIRED', 'V3 Stop requires its live SQL command authorizer.', 409)
  await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const { publication, snapshot } = await openLifecycle(sql, runId)
    await authorize(sql)
    beforeGraphCommit(sql, () => authorize(sql))
    if (snapshot.stopRequested || snapshot.run.executionState === 'completed') {
      await verifyRunReplay(sql, snapshot.run, snapshot.stopRequested)
      return
    }
    const changed = await sql.query('update runs set stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) where id=$1', [runId])
    if (changed.rowCount !== 1) throw new DomainError('RUN_NOT_FOUND', 'The Run disappeared during Stop publication.', 409)
    await sql.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=now()`, [runId])
    const receipt = await publication.repeatStoppedRunReadback()
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: publication.scope, evidence: receipt.evidence,
      sourceDigest: receipt.sourceDigest, semanticDigest: receipt.semanticDigest, effect: null })
  }))
}
