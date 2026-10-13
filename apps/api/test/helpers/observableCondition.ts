export async function readUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: {
    timeoutMs: number
    description: string
    subscribe?: (changed: () => void) => () => void
    minimumReadIntervalMs?: number
  },
): Promise<T> {
  const deadline = performance.now() + options.timeoutMs
  let expire!: () => void
  const expired = new Promise<void>(resolve => { expire = resolve })
  const timer = setTimeout(expire, options.timeoutMs)
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  try {
    for (;;) {
      let changed!: () => void
      const notification = new Promise<void>(resolve => { changed = resolve })
      // Subscribe before reading so a commit during the snapshot cannot be missed.
      const unsubscribe = options.subscribe?.(changed)
      try {
        const readStarted = performance.now()
        const value = await read()
        if (accept(value)) return value
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${options.description}.`)
        // Commit notifications wake the read immediately; polling covers external native progress.
        const pollIntervalMs = options.subscribe ? 1000 : 25
        const polling = new Promise<void>(resolve => { pollTimer = setTimeout(resolve, pollIntervalMs) })
        await Promise.race([notification, polling, expired])
        clearTimeout(pollTimer)
        // Reconciliation reads can publish their own notifications; bound that feedback loop.
        const remainingIntervalMs = readStarted + (options.minimumReadIntervalMs ?? 0) - performance.now()
        if (remainingIntervalMs > 0) {
          const interval = new Promise<void>(resolve => {
            pollTimer = setTimeout(resolve, remainingIntervalMs)
          })
          await Promise.race([interval, expired])
        }
      } finally {
        clearTimeout(pollTimer)
        unsubscribe?.()
      }
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(pollTimer)
  }
}
