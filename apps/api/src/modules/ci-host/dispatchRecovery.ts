import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiHostReplySchema, type CiHostReply, type CiHostStatus,
  type CiRunRecord } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { CiRunSettlement, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { CI_START_ACK_TIMEOUT_MS, CI_START_MAX_ATTEMPTS, releaseCiDispatch, rejectedCiStart,
  requestCiStart, withCiTicketLock } from './dispatch.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { dispatchCloudTicket } from './cloudDispatch.js'

const log = componentLogger('jobs')
export type CiDispatchState = Pick<CiRunSettlement, 'state' | 'step' | 'exitCode' | 'startedAt' | 'finishedAt' | 'message'
  | 'collection' | 'provenance'>
interface DispatchServices {
  pool: pg.Pool
  endpoint: HostCiEndpoint
  read(id: string, workspaceId: string, client: pg.PoolClient): Promise<CiRunRecord>
  settle(run: CiRunRecord, computer: HostCiComputer, state: CiDispatchState,
    options: { client: pg.PoolClient }): Promise<boolean>
}

async function retainDispatch(client: SqlQuery, run: CiRunRecord, computer: HostCiComputer,
  message: string, attempts = run.dispatchAttempts) {
  const next = { ...run, message: sanitizeCiText(message).slice(0, 2000), dispatchAttempts: attempts }
  if (next.message === run.message && attempts === run.dispatchAttempts) return run
  const saved = await client.query(`update ci_runs set state=$2,host_key=$3,record=$4::jsonb
    where id=$1 and state='starting' and host_key=$3 and record=$5::jsonb`,
  [run.id, run.state, computer.key, serializeCiJson(next), JSON.stringify(run)])
  return saved.rowCount ? next : null
}

export async function sendCiDispatch(services: DispatchServices, run: CiRunRecord, computer: HostCiComputer) {
  const outcome = await withCiTicketLock(services.pool, run.id, async client => {
    const current = await services.read(run.id, run.workspaceId, client)
    if (current.cancellation) return 'pending'
    if ((!current.dispatchRequest && !(computer.hostRef.kind === 'cloud' && current.state === 'starting'))
      || !isDeepStrictEqual(current.computer?.hostRef, computer.hostRef)) return 'settled'
    return sendAssignedDispatch(services, current, computer, client)
  })
  return outcome ?? 'pending'
}

async function sendAssignedDispatch(services: DispatchServices, run: CiRunRecord,
  computer: HostCiComputer, client: pg.PoolClient) {
  if (computer.hostRef.kind === 'cloud') {
    const result = await dispatchCloudTicket(client, services.endpoint, computer, run)
    if (result.outcome === 'settled') await services.settle(result.run, computer, result.observed, { client })
    return result.outcome
  }
  const request = run.dispatchRequest
  if (!request) throw new Error('CI dispatch request is missing.')
  let reply: Extract<CiHostReply, { operation: 'start' }>
  try {
    const response = CiHostReplySchema.parse(await requestCiStart(() => services.endpoint.request(computer, request)))
    if (response.operation !== 'start') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    }
    reply = response
  } catch (error) {
    if (!rejectedCiStart(error) || (run.dispatchAttempts ?? 1) > 1) {
      const message = error instanceof Error ? error.message : String(error)
      await retainDispatch(client, run, computer, `${message} Ownership retained until execution is reconciled.`)
      log.warn({ err: error, runId: run.id, computer: computer.key }, 'CI start reply unknown; retaining executor')
      return 'pending'
    }
    if ((error as DomainError).code === 'CI_MIRROR_PRIVATE_DATA') {
      const now = new Date().toISOString()
      await services.settle(run, computer, { state: 'failed', step: null, exitCode: null,
        startedAt: now, finishedAt: now, message: (error as Error).message }, { client })
      return 'settled'
    }
    if (!await releaseCiDispatch(client, run, computer, (error as Error).message, { clearRetry: true })) return 'pending'
    return (error as DomainError).code === 'CI_HOST_BUSY' ? 'busy' : 'rejected'
  }
  await services.settle(run, computer, reply.run, { client })
  return 'settled'
}

export async function reconcileCiHostStart(services: DispatchServices, run: CiRunRecord,
  computer: HostCiComputer, status: CiHostStatus | null) {
  if (computer.hostRef.kind === 'cloud' || run.state !== 'starting' || run.startedAt || run.cancellation) return false
  const outcome = await withCiTicketLock(services.pool, run.id, async client => {
    const current = await services.read(run.id, run.workspaceId, client)
    if (current.state !== 'starting' || current.startedAt || current.cancellation
      || !isDeepStrictEqual(current.computer?.hostRef, computer.hostRef)
      || current.dispatchedAt !== run.dispatchedAt || current.dispatchAttempts !== run.dispatchAttempts) return false
    const observed = status?.runs.find(value => value.runId === current.id)
    if (observed) {
      if (observed.state === 'starting' && observed.step === 'dispatch') return false
      return services.settle(current, computer, observed, { client })
    }
    const attempts = current.dispatchAttempts ?? 1
    if (attempts >= CI_START_MAX_ATTEMPTS) {
      return Boolean(await retainDispatch(client, current, computer,
        `CI start was not acknowledged after ${attempts} attempts. Ownership retained; Operator cancellation is required.`))
    }
    if (!status) {
      const elapsed = Date.now() - Date.parse(current.dispatchedAt ?? current.queuedAt)
      if (elapsed < CI_START_ACK_TIMEOUT_MS) return false
      return Boolean(await retainDispatch(client, current, computer,
        'The start acknowledgement timed out and computer status is unavailable. Ownership retained; cancellation remains pending.'))
    }
    if (!status.ready || !current.dispatchRequest) return false
    // An absent status entry does not prove an earlier request stopped; retries keep the same assignment and run ID.
    // Commit the retry counter before entry without holding a row lock that would block cancellation intent.
    const retry = await retainDispatch(services.pool, current, computer,
      'The computer reports no such CI run. Retrying the assigned executor.', attempts + 1)
    if (!retry) return false
    await sendAssignedDispatch(services, retry, computer, client)
    return true
  })
  return outcome ?? false
}
