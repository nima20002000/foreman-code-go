import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'
import { maintainCredential } from './credentialHeartbeat.js'

const stops: Array<() => Promise<void>> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
})

afterEach(async () => {
  const stopping = Promise.all(stops.splice(0).map((stop) => stop()))
  await vi.advanceTimersByTimeAsync(1_000)
  await stopping
  vi.useRealTimers()
})

function fixture(remainingMs = WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
  let expiresAt: string | undefined = new Date(Date.now() + remainingMs).toISOString()
  const controller = new AbortController()
  const onFailure = vi.fn()
  const check = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => {
    expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  })
  const stop = maintainCredential({ expiresAt: () => expiresAt, check, refresh, signal: controller.signal, onFailure })
  stops.push(stop)
  return { check, refresh, onFailure, controller, stop, setExpiry: (value: string | undefined) => { expiresAt = value } }
}

it('keeps checking continuation before the renewal window without renewing early', async () => {
  const f = fixture(15 * 60_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.check).toHaveBeenCalledTimes(2)
  expect(f.refresh).not.toHaveBeenCalled()
  f.check.mockRejectedValueOnce(new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Execution stopped', 409))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  expect(f.refresh).not.toHaveBeenCalled()
})

it('retries a transient continuation failure long before expiry and checks ownership again', async () => {
  const f = fixture(15 * 60_000)
  f.check.mockRejectedValueOnce(new Error('Query read timeout'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.check).toHaveBeenCalledTimes(2)
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.onFailure).not.toHaveBeenCalled()
  f.check.mockRejectedValueOnce(new DomainError('RUN_OWNERSHIP_LOST', 'Owner disconnected', 409))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
})

it('waits for the renewal window initially and after each renewal', async () => {
  const f = fixture(15 * 60_000)
  await vi.advanceTimersByTimeAsync(14 * 60_000 - 1)
  expect(f.refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(14 * 60_000 - 1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it.each([
  Object.assign(new Error('Statement timed out'), { code: '57014' }),
  Object.assign(new Error('Transaction conflicted'), { code: '40001' }),
  Object.assign(new Error('Database is busy'), { code: '55P03' }),
  Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
  new Error('Query read timeout'),
  new Error('timeout exceeded when trying to connect'),
  new DomainError('DATABASE_READ_TIMEOUT', 'Read timed out', 503, { retryable: true }),
])('retries a transient refresh failure while the original credential is valid: %s', async (error) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(999)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

it('caps retry backoff and stops at the last confirmed expiry safety margin', async () => {
  const f = fixture()
  const started = Date.now()
  const attempts: number[] = []
  f.refresh.mockImplementation(async () => {
    attempts.push(Date.now() - started)
    throw Object.assign(new Error('Statement timed out'), { code: '57014' })
  })
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS - 1)
  expect(attempts.slice(0, 5)).toEqual([0, 1_000, 3_000, 7_000, 12_000])
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  const count = attempts.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(attempts).toHaveLength(count)
})

it.each([
  new DomainError('RUN_OWNERSHIP_LOST', 'Owner disconnected', 409),
  new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Execution stopped', 409),
  new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'Credential revoked', 409),
  new DomainError('AUTH_REVOKED', 'Authorization revoked', 403),
  new Error('The execution lost its native credential lease.'),
])('stops immediately for ownership, continuation or credential loss: %s', async (error) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(error)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

it('keeps the expiry deadline active while refresh is hanging and never overlaps refreshes', async () => {
  const f = fixture()
  let finish!: () => void
  f.refresh.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
})

it.each(['abort', 'stop'])('cancels a pending retry on %s', async (action) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(new Error('Query read timeout'))
  await vi.advanceTimersByTimeAsync(0)
  if (action === 'abort') f.controller.abort()
  else await f.stop()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it.each([undefined, 'invalid', new Date('2029-12-31T23:59:59Z').toISOString()])(
  'stops if refresh loses the confirmed expiry: %s', async (expiry) => {
    const f = fixture()
    f.refresh.mockImplementation(async () => { f.setExpiry(expiry) })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onFailure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.refresh).toHaveBeenCalledTimes(1)
  },
)
