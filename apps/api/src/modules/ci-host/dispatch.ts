import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'
import { withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import { ExecutionLimiter } from '../runs/limiter.js'
import { sanitizeCiText, serializeCiJson } from './text.js'

const dispatchLimits = new WeakMap<pg.Pool, ExecutionLimiter>()
const dispatchSignal = new AbortController().signal

/** Serialize remote entry and closure across Main processes without blocking cancellation intent writes. */
export async function withCiTicketLock<T>(pool: pg.Pool, ticketId: string, work: (client: pg.PoolClient) => Promise<T>) {
  let limit = dispatchLimits.get(pool)
  if (!limit) {
    // Remote endpoint validation also reads the pool; leave connections available for it and cancellation intent.
    limit = new ExecutionLimiter(Math.max(1, pool.options.max - 2))
    dispatchLimits.set(pool, limit)
  }
  return limit.run(dispatchSignal, () => withTransaction(pool, async client => {
    const row = (await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired', [`ci-dispatch:${ticketId}`])).rows[0]
    if (!row?.acquired) return undefined
    return work(client)
  }))
}

/** A stale planning or queue snapshot may only replace the same unassigned queued record. */
export async function saveQueuedCiRun(pool: pg.Pool, previous: CiRunRecord, next: CiRunRecord) {
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
  [previous.id, next.state, null, serializeCiJson(next), JSON.stringify(previous)])
  return Boolean(saved.rowCount)
}

/** Only the winning database claim may enter an executor. Unknown delivery keeps this assignment. */
export async function claimCiDispatch(pool: pg.Pool, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | null> {
  const next = CiRunRecordSchema.parse({ ...run, state: 'starting', step: 'dispatch', message: null,
    computer: { hostRef: computer.hostRef, label: computer.label }, dispatchRequest: request })
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return saved.rowCount ? next : null
}

/** This is only safe after the executor definitely rejected entry. */
export async function releaseCiDispatch(sql: SqlQuery, run: CiRunRecord, computer: HostCiComputer, message: string) {
  const next = CiRunRecordSchema.parse({ ...run, state: 'queued', computer: null, step: null,
    dispatchRequest: undefined, message: sanitizeCiText(message).slice(0, 2000) })
  const saved = await sql.query(`update ci_runs set state=$2, host_key=null, record=$4::jsonb
    where id=$1 and state='starting' and host_key=$3 and record=$5::jsonb`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return Boolean(saved.rowCount)
}

export function ciMessages(run: CiRunRecord, observed: string | null) {
  const providerMessage = observed?.slice(0, 2000) ?? null
  const history = [...run.messageHistory ?? []]
  if (providerMessage && providerMessage !== run.providerMessage) {
    if (!history.includes(providerMessage)) history.push(providerMessage)
  }
  const messageHistory = history.slice(-8)
  const message = run.supersededBy ? `superseded by ${run.supersededBy}` : providerMessage
  return { providerMessage, messageHistory, message }
}

export function rejectedCiStart(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['CI_HOST_BUSY', 'COMPUTER_GITHUB_REQUIRED', 'CI_CLOUD_UNAVAILABLE',
    'BUILD_COMPUTER_DISABLED', 'CI_MIRROR_PRIVATE_DATA'].includes(String(error.code))
}
