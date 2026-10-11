export async function readUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: { timeoutMs: number; description: string; subscribe?: (changed: () => void) => () => void },
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
        const value = await read()
        if (accept(value)) return value
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${options.description}.`)
        // Retry deadlines and external native progress do not necessarily commit a row.
        const polling = new Promise<void>(resolve => { pollTimer = setTimeout(resolve, 25) })
        await Promise.race([notification, polling, expired])
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
