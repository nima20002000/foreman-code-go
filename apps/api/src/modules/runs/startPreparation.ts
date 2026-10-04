import { DomainError } from '../errors.js'

export const START_PREPARATION_TIMEOUT_MS = 5_000

/** Only read-only preflight is raced. Its signal fences every later admission
 * step, so a late result cannot resume Start after the caller has timed out. */
export async function prepareRunStart<T>(operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new DomainError(
    'RUN_START_PREPARATION_TIMEOUT', 'Start preparation did not finish before its deadline.', 504,
  )), START_PREPARATION_TIMEOUT_MS)
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason)
    combined.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([operation(combined), cancelled])
    combined.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', abort)
  }
}
