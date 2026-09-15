/** FIFO, run-local capacity. Waiting nodes cannot launch after cancellation. */
export class ExecutionLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('maxParallelism must be a positive integer.')
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          const index = this.waiting.indexOf(enter)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(signal.reason)
        }
        this.waiting.push(enter)
        signal.addEventListener('abort', abort, { once: true })
      })
      // The releasing worker transfers its existing slot to this waiter.
    } else {
      this.active += 1
    }
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
