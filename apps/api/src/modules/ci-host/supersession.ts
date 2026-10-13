import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { CiCommits } from './service.js'

/** Admission and the cancellation intent share a transaction; dispatch retries unfinished cleanup. */
export async function supersedeCiRuns(client: pg.PoolClient, commits: CiCommits, replacement: CiRunRecord,
  audit: { source: 'mcp' | 'http'; commandId: string }) {
  if (!commits.isAncestor || replacement.branch === undefined || !replacement.defaultBranch
    || replacement.branch === replacement.defaultBranch) return
  const rows = (await client.query<{ record: unknown }>(`select record from ci_runs
    where workspace_id=$1 and state in ('queued','starting','running')
      and record->>'repository'=$2 and record->>'suite'=$3
      and (record#>>'{initiator,principalId}'=$4
        or ($5::text is not null and record#>>'{initiator,executionId}'=$5))
    order by created_at,id for update`,
  [replacement.workspaceId, replacement.repository, replacement.suite,
    replacement.initiator.principalId, replacement.initiator.executionId])).rows
  const ancestry = new Map<string, boolean>()
  for (const row of rows) {
    const old = CiRunRecordSchema.parse(row.record)
    if (old.commit === replacement.commit || old.noSupersede || old.supersededBy) continue
    const branch: string | null | undefined = old.branch === undefined
      ? await commits.branch?.(old.repository, replacement.defaultBranch, old.commit) : old.branch
    if (branch === undefined || branch === replacement.defaultBranch || branch === old.defaultBranch) continue
    const sameExecution = replacement.initiator.executionId !== null
      && old.initiator.executionId === replacement.initiator.executionId
    const sameBranch = replacement.branch !== null && branch === replacement.branch
      && old.initiator.principalId === replacement.initiator.principalId
    if (!sameExecution && !sameBranch) continue
    if (!ancestry.has(old.commit)) {
      ancestry.set(old.commit, await commits.isAncestor(replacement.repository, old.commit, replacement.commit))
    }
    if (!ancestry.get(old.commit)) continue
    const next = { ...old, supersededBy: replacement.id, message: `superseded by ${replacement.id}` }
    await client.query('update ci_runs set record=$2::jsonb where id=$1', [old.id, JSON.stringify(next)])
    await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'ci.supersede',$3,'succeeded',$4::jsonb)`,
    [replacement.initiator.principalId, audit.source, `ci:${old.id}`, JSON.stringify({
      commandId: audit.commandId, ticketId: old.id, supersededBy: replacement.id,
    })])
  }
}
