import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'

/** Persisted ci_runs rows; each write replaces only the exact record it read, like the real compare-and-set. */
export function ticketStore(initial: CiRunRecord[], hostKeys: Record<string, string> = {}) {
  const rows = new Map(initial.map(run => [run.id, { state: run.state as string, hostKey: hostKeys[run.id] ?? null,
    record: run as unknown }]))
  const matches = (id: unknown, previous: unknown) => {
    const row = rows.get(id as string)
    return row && isDeepStrictEqual(row.record, JSON.parse(previous as string)) ? row : undefined
  }
  const listed = (filter: (run: CiRunRecord, row: { state: string; hostKey: string | null }) => boolean) =>
    [...rows].filter(([, row]) => filter(CiRunRecordSchema.parse(row.record), row))
      .map(([id, row]) => ({ id, state: row.state, host_key: row.hostKey, record: row.record, durations: null }))
  const changed = (row: { state: string; hostKey: string | null; record: unknown } | undefined,
    next: { state?: unknown; hostKey?: unknown; record: unknown }) => {
    if (!row) return { rows: [], rowCount: 0 }
    if (next.state !== undefined) row.state = next.state as string
    if (next.hostKey !== undefined) row.hostKey = next.hostKey as string | null
    row.record = JSON.parse(next.record as string)
    return { rows: [], rowCount: 1 }
  }
  const query = async (sql: string, p: unknown[] = []) => {
    const text = sql.replace(/\s+/gu, ' ').trim()
    if (text.startsWith('insert into ci_dispatch_claims') || text.startsWith('update ci_dispatch_claims')) {
      return { rows: [{ ticket_id: p[0] }], rowCount: 1 }
    }
    if (text.startsWith('update ci_runs set record=$2::jsonb')) {
      return changed(matches(p[0], p[2]), { record: p[1] })
    }
    if (text.startsWith('select id,state,record')) return { rows: listed(() => true) }
    if (text.startsWith('update ci_runs set state=$2, host_key=case')) {
      const row = matches(p[0], p[5])
      return changed(row?.state === p[3] ? row : undefined, { state: p[1], hostKey: p[4] ? undefined : null, record: p[2] })
    }
    if (text.startsWith('update ci_runs set host_key=null, record=$2::jsonb')) {
      return changed(matches(p[0], p[2]), { hostKey: null, record: p[1] })
    }
    if (text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb where id=$1 and state=\'queued\'')) {
      return changed(matches(p[0], p[4]), { state: p[1], hostKey: p[2], record: p[3] })
    }
    if (text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb,')
      || text.startsWith('update ci_runs set state=$2, host_key=$3, log_tail=')) {
      return changed(matches(p[0], p[8]), { state: p[1], hostKey: p[2], record: p[3] })
    }
    if (text.startsWith('update ci_runs set record=$4::jsonb where id=$1 and state=$2 and workspace_id=$3')) {
      return changed(matches(p[0], p[4]), { record: p[3] })
    }
    if (text.startsWith('select record from ci_runs where id=$1')) return { rows: listed(run => run.id === p[0]) }
    if (text.startsWith('select id,record,host_key from ci_runs')) {
      return { rows: listed(run => ['starting', 'running'].includes(run.state) || run.collection === 'pending'
        || run.observation?.status === 'unavailable') }
    }
    if (text.startsWith('select host_key,record from ci_runs')) {
      return { rows: listed(run => ['starting', 'running'].includes(run.state) || run.deadlineExceeded?.executor === 'retained') }
    }
    if (text.startsWith('select record,durations from ci_runs where state=\'queued\'')) {
      return { rows: listed(run => run.state === 'queued') }
    }
    return { rows: [], rowCount: 0 }
  }
  const pool = { options: { max: 10 }, query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  return { pool, read: (id: string) => ({ ...rows.get(id)!, record: CiRunRecordSchema.parse(rows.get(id)!.record) }) }
}
