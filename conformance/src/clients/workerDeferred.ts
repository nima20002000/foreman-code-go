export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // The owner awaits this promise; this observer also covers early socket failure.
  void promise.catch(() => { /* ignore: the owning request reports this same rejection. */ })
  return { promise, resolve, reject }
}

export async function withWorkerDeadline<T>(operation: Promise<T>, signal?: AbortSignal, timeoutMs = 15_000) {
  if (signal?.aborted) throw signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The test worker operation timed out.')), timeoutMs)
      aborted = () => reject(signal?.reason ?? new Error('The test worker operation was canceled.'))
      signal?.addEventListener('abort', aborted, { once: true })
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (aborted) signal?.removeEventListener('abort', aborted)
  }
}
