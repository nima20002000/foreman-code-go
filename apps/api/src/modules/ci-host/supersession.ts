import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { CiCommits } from './service.js'
import { serializeCiJson } from './text.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'

async function candidates(sql: SqlQuery, replacement: CiRunRecord, lock?: 'update'): Promise<CiRunRecord[]> {
  const rows = (await sql.query<{ record: unknown }>(`select record from ci_runs
    where workspace_id=$1 and state in ('queued','starting','running')
      and record->>'repository'=$2 and record->>'suite'=$3
      and (record#>>'{initiator,principalId}'=$4
        or ($5::text is not null and record#>>'{initiator,executionId}'=$5))
    order by created_at,id${lock ? ' for update' : ''}`,
  [replacement.workspaceId, replacement.repository, replacement.suite,
    replacement.initiator.principalId, replacement.initiator.executionId])).rows
  return rows.map(row => CiRunRecordSchema.parse(row.record))
}

function protectedRun(old: CiRunRecord, replacement: CiRunRecord): boolean {
  return old.commit === replacement.commit || Boolean(old.noSupersede || old.supersededBy)
}

/** Resolve Git facts without holding row or admission locks. */
export async function prepareCiSupersession(sql: SqlQuery, commits: CiCommits, replacement: CiRunRecord) {
  if (!commits.isAncestor || replacement.branch === undefined || !replacement.defaultBranch
    || replacement.branch === replacement.defaultBranch) return undefined
  const prepared = new Map<string, boolean>()
  const ancestry = new Map<string, boolean>()
  for (const old of await candidates(sql, replacement)) {
    prepared.set(old.id, false)
    if (protectedRun(old, replacement)) continue
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
    prepared.set(old.id, ancestry.get(old.commit)!)
  }
  return prepared
}

/** Newly arrived candidates require another preparation pass outside the transaction. */
export async function validateCiSupersession(client: pg.PoolClient, replacement: CiRunRecord,
  prepared: Map<string, boolean> | undefined): Promise<CiRunRecord[] | null> {
  if (!prepared) return []
  const rows = await candidates(client, replacement, 'update')
  if (rows.some(old => !protectedRun(old, replacement) && !prepared.has(old.id))) return null
  return rows.filter(old => !protectedRun(old, replacement) && prepared.get(old.id))
}

/** Admission and cancellation intent share a transaction; dispatch retries unfinished cleanup. */
export async function supersedeCiRuns(client: pg.PoolClient, replacement: CiRunRecord, rows: CiRunRecord[],
  audit: { source: 'mcp' | 'http'; commandId: string }) {
  for (const old of rows) {
    const next = { ...old, supersededBy: replacement.id, message: `superseded by ${replacement.id}` }
    await client.query('update ci_runs set record=$2::jsonb where id=$1', [old.id, serializeCiJson(next)])
    await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'ci.supersede',$3,'succeeded',$4::jsonb)`,
    [replacement.initiator.principalId, audit.source, `ci:${old.id}`, JSON.stringify({
      commandId: audit.commandId, ticketId: old.id, supersededBy: replacement.id,
    })])
  }
}
