import { isDatabaseTimeout } from '../../infrastructure/databaseTimeout.js'
import { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'

function isTransientRefreshFailure(error: unknown): boolean {
  if (isDatabaseTimeout(error)) return true
  if (error instanceof DomainError) return error.status === 503 && error.details?.retryable === true
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  if (typeof code === 'string' && (code.startsWith('08') || [
    '40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03',
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  ].includes(code))) return true
  return error instanceof Error && [
    'Query read timeout',
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
  ].includes(error.message)
}

/** Renew even when a native event iterator is silent. No token leaves its owner. */
export function maintainCredential(input: {
  expiresAt(): string | undefined
  check?(): Promise<void>
  refresh(): Promise<void>
  signal: AbortSignal
  onFailure(error: Error): void
}): () => Promise<void> {
  let stopped = false
  let running: Promise<void> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryMs = 1_000
  const fail = (error: unknown) => {
    if (stopped || input.signal.aborted) return
    stopTimers()
    input.onFailure(error instanceof Error ? error : new Error('Worker credential renewal failed.'))
  }
  const stopTimers = () => {
    stopped = true
    clearTimeout(timer)
    clearTimeout(deadline)
    input.signal.removeEventListener('abort', stopTimers)
  }
  const schedule = (backoffMs?: number) => {
    if (stopped || input.signal.aborted) return
    const expiry = input.expiresAt()
    const remaining = expiry ? Date.parse(expiry) - Date.now() : NaN
    if (!Number.isFinite(remaining) || remaining <= WORKER_CREDENTIAL_EXPIRY_MARGIN_MS) {
      fail(new Error('The native credential could not be renewed before its safety deadline.'))
      return
    }
    clearTimeout(deadline)
    // This deadline also stops native work if a database renewal hangs.
    const safeRemaining = remaining - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS
    deadline = setTimeout(() => fail(new Error('Worker credential renewal timed out.')), safeRemaining)
    deadline.unref()
    const waitMs = backoffMs ?? Math.min(20_000, Math.max(1_000, remaining - WORKER_CREDENTIAL_RENEWAL_WINDOW_MS))
    timer = setTimeout(tick, Math.min(waitMs, safeRemaining))
    timer.unref()
  }
  const tick = () => {
    if (stopped || input.signal.aborted) return
    const expiry = input.expiresAt()
    if (!expiry) { fail(new Error('The native process lost its credential lease.')); return }
    const remaining = Date.parse(expiry) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= WORKER_CREDENTIAL_EXPIRY_MARGIN_MS) {
      fail(new Error('The native credential could not be renewed before its safety deadline.')); return
    }
    running = Promise.resolve().then(() => {
      if (stopped || input.signal.aborted) return
      return input.check?.()
    }).then(() => {
      if (stopped || input.signal.aborted) return
      const expiry = input.expiresAt()
      if (expiry && Date.parse(expiry) <= Date.now() + WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        return input.refresh()
      }
    }).then(() => {
      if (stopped || input.signal.aborted) return
      retryMs = 1_000
      schedule()
    }).catch((error: unknown) => {
      if (!isTransientRefreshFailure(error)) {
        fail(error)
        return
      }
      schedule(retryMs)
      retryMs = Math.min(5_000, retryMs * 2)
    }).finally(() => { running = undefined })
  }
  input.signal.addEventListener('abort', stopTimers, { once: true })
  if (input.signal.aborted) stopTimers()
  else schedule(0)
  return async () => {
    stopTimers()
    // Do not hold execution finalization forever behind a stalled renewal query.
    // The owner checks inside refresh prevent a late completion reviving the lease.
    const pending = running
    if (pending) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([pending, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1_000) })]) }
      finally { clearTimeout(timeout) }
    }
  }
}
