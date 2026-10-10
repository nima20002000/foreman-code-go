import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { PrivateSourceSnapshotStore } from './store.js'

export const SOURCE_RETENTION_SECONDS = 3600

/** Current profiles retain their source so qualification can still be requested. */
/** Under storage pressure, a snapshot that nothing actively uses is released before its retention window ends:
 * otherwise a busy day of commits fills Main's capture budget and blocks every new CI request. */
async function releasable(sql: GraphSqlClient, snapshotId: string, underPressure = false): Promise<boolean> {
  const result = await sql.query<{ releasable: boolean }>(`with uses(active,used_at,retention) as (
    select e.record#>>'{process,phase}' is distinct from 'terminal'
        or e.record#>>'{process,processStopped}' is distinct from 'true'
        or e.record->>'publication' in ('pending','collecting'),
      greatest((e.record->>'updatedAt')::timestamptz,(e.record->>'finishedAt')::timestamptz),
      (e.accepted_spec#>>'{policy,retentionSeconds}')::integer
    from job_executions e where e.accepted_spec#>>'{source,snapshotId}'=$1
    union all
    select q.record->>'state' is distinct from 'terminal' or q.record->>'cleanupStatus'='pending',
      coalesce((q.record->>'finishedAt')::timestamptz,(q.record->>'enqueuedAt')::timestamptz),
      (q.record#>>'{definition,spec,policy,retentionSeconds}')::integer
    from job_admission_queue q where q.record#>>'{definition,spec,source,snapshotId}'=$1
    union all
    select e.id is null and c.status is distinct from 'closed',
      greatest(p.created_at,(c.closure->>'observedAt')::timestamptz),
      (p.definition#>>'{spec,policy,retentionSeconds}')::integer
    from job_preparations p left join job_executions e on e.id=p.execution_id
      left join source_preparation_reconciliations c on c.operation_id=p.operation_id
    where p.definition#>>'{spec,source,snapshotId}'=$1
    union all
    select s.released_at is null,s.released_at,(s.spec#>>'{policy,retentionSeconds}')::integer
    from job_computer_selections s where s.spec#>>'{source,snapshotId}'=$1
    union all
    select true,null::timestamptz,null::integer
    from source_storage_reservations s
      left join job_preparations p on p.operation_id=s.owner_id
      left join job_computer_selections c on c.operation_id=s.owner_id
      left join execution_dispatch_intents i on i.operation_id=s.owner_id
      left join run_node_placements n on n.run_id=i.run_id and n.node_id=i.node_id
    where s.owner_kind='materialization' and s.state in ('preparing','owned','uncertain')
      and (p.definition#>>'{spec,source,snapshotId}'=$1 or c.spec#>>'{source,snapshotId}'=$1
        or n.record#>>'{source,snapshotId}'=$1 or s.record#>>'{preparation,source,snapshotId}'=$1)
    union all
    select m.state<>'closed',
      greatest((m.record#>>'{receipt,verifiedAt}')::timestamptz,m.cleanup_lease_expires_at),null::integer
    from source_execution_materializations m
    where m.record#>>'{receipt,binding,snapshotId}'=$1
    union all
    select c.status<>'closed',
      greatest(c.created_at,(c.closure->>'observedAt')::timestamptz),null::integer
    from source_preparation_reconciliations c where c.owner#>>'{source,snapshotId}'=$1
    union all
    select r.execution_state<>'completed' or exists(
        select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending),
      coalesce((r.record->>'finishedAt')::timestamptz,(r.record->>'createdAt')::timestamptz),null::integer
    from run_node_placements p join runs r on r.id=p.run_id
    where p.record#>>'{source,snapshotId}'=$1 or p.record#>>'{source,revisionId}'=$1
    union all
    select r.execution_state<>'completed' or exists(
        select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending),
      coalesce((r.record->>'finishedAt')::timestamptz,(r.record->>'createdAt')::timestamptz),
      (d.record#>>'{spec,policy,retentionSeconds}')::integer
    from runs r join workflow_versions v on v.id=r.workflow_version_id
      cross join lateral jsonb_array_elements(v.record#>'{definition,nodes}') n
      join job_definition_versions d on d.id=n->>'jobDefinitionVersionId'
    where d.record#>>'{spec,source,snapshotId}'=$1
    union all
    select true,(p.record->>'updatedAt')::timestamptz,null::integer
    from job_runtime_profiles p where p.record#>>'{root,source,snapshotId}'=$1
    union all
    select a.record->>'status' in ('qualifying','recovery-required')
        or (a.record->>'status' in ('captured','awaiting-approval','approved')
          and (a.record->>'expiresAt')::timestamptz>clock_timestamp()),
      greatest((a.record->>'requestedAt')::timestamptz,(a.record->>'expiresAt')::timestamptz),null::integer
    from job_runtime_qualification_approvals a where a.record#>>'{fingerprint,root,source,snapshotId}'=$1
    union all
    select true,null::timestamptz,null::integer
    from workspace_repository_imports i join workspaces w on w.id=i.workspace_id
    where i.phase='ready' and w.archived_at is null
      and i.results#>>'{approvedSource,manifest,snapshotId}'=$1
      and w.record->'repository'=i.input->'repository'
      and w.location_revision::text=i.results#>>'{location,locationRevision}'
    union all
    select true,null::timestamptz,null::integer
    from workflows w join workspaces workspace on workspace.id=w.workspace_id
      join workflow_versions v on v.id=w.current_version_id
      join source_root_bindings b
        on b.workspace_id=w.workspace_id
        and b.root_id::text=v.record#>>'{definition,defaultWorktree,rootBinding,rootId}'
        and b.binding_revision::text=v.record#>>'{definition,defaultWorktree,rootBinding,bindingRevision}'
    where b.snapshot_id::text=$1 and w.archived_at is null and workspace.archived_at is null
    union all
    select true,null::timestamptz,null::integer
    from workflows w join workspaces workspace on workspace.id=w.workspace_id
      join workflow_versions v on v.id=w.current_version_id
      cross join lateral jsonb_array_elements(v.record#>'{definition,nodes}') node
      join source_root_bindings b on b.workspace_id=w.workspace_id
        and b.root_id::text=node#>>'{placement,rootBinding,rootId}'
        and b.binding_revision::text=node#>>'{placement,rootBinding,bindingRevision}'
    where b.snapshot_id::text=$1 and w.archived_at is null and workspace.archived_at is null
    union all
    select false,(b.record->>'boundAt')::timestamptz,null::integer
    from source_root_bindings b where b.snapshot_id::text=$1
  ) select not coalesce(bool_or(active),false)
      and ($3::boolean or greatest(max(used_at),(s.record->>'approvedAt')::timestamptz)
        + make_interval(secs=>coalesce(max(retention),$2)) < clock_timestamp()) as releasable
    from source_snapshots s left join uses on true where s.snapshot_id::text=$1 group by s.record`,
  [snapshotId, SOURCE_RETENTION_SECONDS, underPressure])
  return result.rows[0]?.releasable === true
}

type Candidate = { snapshot_id: string; requested_by: string; command_id: string }

async function lockSnapshot(sql: pg.PoolClient, candidate: Candidate, scopeId: string) {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${scopeId}`])
  const command = (await sql.query<{ locked: boolean }>(
    'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
    [`command:${candidate.requested_by}:source.approve:${candidate.command_id}`])).rows[0]
  if (!command?.locked) return null
  // Admission locks the snapshot before storage; skip its row to avoid reversing that lock order.
  const snapshot = (await sql.query<{ availability: string; workspace_id: string }>(`select availability,workspace_id
    from source_snapshots where snapshot_id=$1 for update skip locked`, [candidate.snapshot_id])).rows[0]
  if (!snapshot) return null
  const reservation = (await sql.query<{ record: SourceReservation }>(`select record
    from source_storage_reservations where scope_id=$1 and owner_kind='capture' and owner_id=$2
      and state='retained' for update`, [scopeId, candidate.snapshot_id])).rows[0]
  return reservation ? { ...snapshot, reservation: reservation.record } : null
}

async function releaseSnapshot(pool: pg.Pool, store: Pick<PrivateSourceSnapshotStore, 'remove'>,
  scopeId: string, candidate: Candidate, underPressure: boolean): Promise<void> {
  const sql = await pool.connect()
  try {
    await sql.query('begin')
    const snapshot = await lockSnapshot(sql, candidate, scopeId)
    if (!snapshot || (snapshot.availability === 'retained' && !await releasable(sql, candidate.snapshot_id, underPressure))) {
      await sql.query('commit')
      return
    }
    await sql.query("update source_snapshots set availability='unavailable' where snapshot_id=$1", [candidate.snapshot_id])
    // Persist the fence before I/O: a crash or rollback can leave charged bytes, never usable missing bytes.
    await sql.query('commit')
    await sql.query('begin')
    const fenced = await lockSnapshot(sql, candidate, scopeId)
    if (fenced?.availability === 'unavailable') {
      await store.remove(candidate.snapshot_id)
      await new PostgresSourceReservations().reclaimed(sql, fenced.reservation, async () => true)
      await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,'system','source.snapshot.release',$2,'succeeded',$3::jsonb)`,
      [candidate.requested_by, fenced.workspace_id, JSON.stringify({ snapshotId: candidate.snapshot_id })])
    }
    await sql.query('commit')
  } catch (error) {
    await sql.query('rollback')
    throw error
  } finally { sql.release() }
}

export async function releaseUnusedSourceSnapshots(pool: pg.Pool,
  store: Pick<PrivateSourceSnapshotStore, 'remove'>, scopeId: string,
  report?: (error: unknown) => void, underPressure = false): Promise<void> {
  const candidates = await pool.query<Candidate>(`select a.snapshot_id,a.requested_by,a.command_id
    from source_approvals a join source_snapshots s on s.snapshot_id=a.snapshot_id
    join source_storage_reservations r on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
    where a.state='approved' and r.state='retained' and r.scope_id=$1 order by a.created_at`, [scopeId])
  for (const candidate of candidates.rows) {
    try {
      await releaseSnapshot(pool, store, scopeId, candidate, underPressure)
    } catch (error) {
      if (!report) throw error
      report(error)
    }
  }
}
