import { AsyncLocalStorage } from 'node:async_hooks'

const priority = new AsyncLocalStorage<{ signal?: AbortSignal | undefined }>()

/** Only CI admission and dispatch may borrow the reserved database connections. */
export function withCiDatabasePriority<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return priority.run({ signal }, work)
}

export function withoutCiDatabasePriority<T>(work: () => Promise<T>): Promise<T> {
  return priority.exit(work)
}

export function ciDatabasePriority() {
  return priority.getStore()
}

/** Claim cleanup must still run when its dispatch pass has expired. */
export function withoutCiDatabaseDeadline<T>(work: () => Promise<T>): Promise<T> {
  return priority.getStore() ? withCiDatabasePriority(work) : work()
}

export async function waitForCiDispatch<T>(work: () => Promise<T>): Promise<T> {
  const signal = priority.getStore()?.signal
  signal?.throwIfAborted()
  if (!signal) return work()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
