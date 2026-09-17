/** Renew even when a native event iterator is silent. No token leaves its owner. */
export function maintainCredential(input: {
  expiresAt(): string | undefined
  refresh(): Promise<void>
  signal: AbortSignal
  onFailure(error: Error): void
}): () => Promise<void> {
  let stopped = false
  let running: Promise<void> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
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
  const tick = () => {
    if (stopped || input.signal.aborted) return
    const expiry = input.expiresAt()
    if (!expiry) { fail(new Error('The native process lost its credential lease.')); return }
    const remaining = Date.parse(expiry) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 5_000) {
      fail(new Error('The native credential could not be renewed before its safety deadline.')); return
    }
    // The independent deadline also stops native work if a database renewal hangs.
    deadline = setTimeout(() => fail(new Error('Worker credential renewal timed out.')), Math.max(1, remaining - 5_000))
    deadline.unref()
    running = Promise.resolve().then(() => {
      if (stopped || input.signal.aborted) return
      return input.refresh()
    }).then(() => {
      if (stopped || input.signal.aborted) return
      clearTimeout(deadline)
      const nextExpiry = input.expiresAt()
      const nextRemaining = nextExpiry ? Date.parse(nextExpiry) - Date.now() : NaN
      if (!Number.isFinite(nextRemaining) || nextRemaining <= 5_000) {
        fail(new Error('Worker credential renewal did not retain a live lease.')); return
      }
      timer = setTimeout(tick, Math.min(20_000, Math.max(1, nextRemaining - 30_000)))
      timer.unref()
    }).catch(fail).finally(() => { running = undefined })
  }
  input.signal.addEventListener('abort', stopTimers, { once: true })
  if (input.signal.aborted) stopTimers()
  else {
    timer = setTimeout(tick, 0)
    timer.unref()
  }
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
