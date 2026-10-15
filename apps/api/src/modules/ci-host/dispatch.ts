import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { ExecutionLimiter } from '../runs/limiter.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { componentLogger } from '../diagnostics/logger.js'

const dispatchLimits = new WeakMap<pg.Pool, ExecutionLimiter>()
const dispatchSignal = new AbortController().signal
export const CI_START_ACK_TIMEOUT_MS = 120_000
export const CI_START_MAX_ATTEMPTS = 3

/** Keep ticket exclusion across network waits without retaining a transaction or row locks. */
export async function withCiTicketLock<T>(pool: pg.Pool, ticketId: string, work: (client: pg.PoolClient) => Promise<T>) {
  let limit = dispatchLimits.get(pool)
  if (!limit) {
    // Remote endpoint validation also reads the pool; leave connections available for it and cancellation intent.
    limit = new ExecutionLimiter(Math.max(1, pool.options.max - 2))
    dispatchLimits.set(pool, limit)
  }
  return limit.run(dispatchSignal, async () => {
    const client = await pool.connect()
    const key = `ci-dispatch:${ticketId}`
    let acquired = false
    let discard = false
    try {
      const row = (await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1,0)) as acquired', [key])).rows[0]
      acquired = row?.acquired === true
      if (!acquired) return undefined
      return await work(client)
    } catch (error) {
      if (!acquired) discard = true
      throw error
    } finally {
      if (acquired) {
        try {
          const row = (await client.query<{ released: boolean }>(
            'select pg_advisory_unlock(hashtextextended($1,0)) as released', [key])).rows[0]
          if (!row?.released) {
            discard = true
            componentLogger('jobs').warn({ ticketId }, 'Discarding connection after CI ticket lock was lost')
          }
        } catch (error) {
          discard = true
          componentLogger('jobs').warn({ err: error, ticketId }, 'Discarding CI ticket lock connection')
        }
      }
      client.release(discard)
    }
  })
}

/** A stale planning or queue snapshot may only replace the same unassigned queued record. */
export async function saveQueuedCiRun(pool: pg.Pool, previous: CiRunRecord, next: CiRunRecord) {
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
  [previous.id, next.state, null, serializeCiJson(next), JSON.stringify(previous)])
  return Boolean(saved.rowCount)
}

/** Only the winning database claim may enter an executor. */
export async function claimCiDispatch(pool: SqlQuery, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | null> {
  const next = CiRunRecordSchema.parse({ ...run, state: 'starting', step: 'dispatch', message: null,
    computer: { hostRef: computer.hostRef, label: computer.label }, dispatchRequest: request,
    dispatchAttempts: computer.hostRef.kind === 'cloud' ? 0 : (run.dispatchAttempts ?? 0) + 1,
    dispatchedAt: new Date().toISOString(),
    ...(computer.hostRef.kind !== 'cloud' ? { dispatchHostKey: computer.key } : {}) })
  const saved = await pool.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
    where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
  [run.id, next.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return saved.rowCount ? next : null
}

/** Uncertain host deliveries retain dispatchHostKey for same-computer retries. */
export async function releaseCiDispatch(sql: SqlQuery, run: CiRunRecord, computer: HostCiComputer, message: string,
  options: { clearRetry?: boolean } = {}) {
  const next = CiRunRecordSchema.parse({ ...run, state: 'queued', computer: null, step: null,
    startedAt: null, finishedAt: null,
    dispatchHostKey: options.clearRetry ? undefined : run.dispatchHostKey ?? computer.key,
    dispatchAttempts: options.clearRetry ? undefined : run.dispatchAttempts ?? 1,
    dispatchRequest: undefined, dispatchedAt: undefined, message: sanitizeCiText(message).slice(0, 2000) })
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
  return {
    ...(providerMessage !== null || run.providerMessage !== undefined ? { providerMessage } : {}),
    ...(messageHistory.length > 0 || run.messageHistory !== undefined ? { messageHistory } : {}),
    message,
  }
}

export function rejectedCiStart(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['CI_HOST_BUSY', 'COMPUTER_GITHUB_REQUIRED', 'CI_CLOUD_UNAVAILABLE',
    'BUILD_COMPUTER_DISABLED', 'CI_HOST_PROTOCOL_UNSUPPORTED', 'CI_MIRROR_PRIVATE_DATA'].includes(String(error.code))
}

/** The request may finish later; its reply cannot settle a ticket after this deadline. */
export async function requestCiStart<T>(request: () => Promise<T>,
  options: { timeoutMs?: number } = {}): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([request(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CI start acknowledgement timed out.')),
        options.timeoutMs ?? CI_START_ACK_TIMEOUT_MS)
      timer.unref()
    })])
  } finally {
    clearTimeout(timer)
  }
}
