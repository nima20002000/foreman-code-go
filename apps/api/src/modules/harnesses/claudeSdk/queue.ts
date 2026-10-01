/** One reader, bounded memory, no event dropping and no blocked producers. */
export class ClaudeBoundedQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private reader: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void } | undefined
  private ended = false
  private failure: unknown
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid Claude queue capacity')
  }
  offer(value: T): void {
    if (this.ended) throw this.failure ?? new Error('Claude queue closed')
    if (this.reader) {
      const reader = this.reader
      this.reader = undefined
      reader.resolve({ done: false, value })
    } else {
      if (this.values.length >= this.capacity) throw new Error('Claude queue capacity exceeded')
      this.values.push(value)
    }
  }
  close(error?: unknown, discard = false): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    if (discard) this.values = []
    if (this.reader) {
      const reader = this.reader
      this.reader = undefined
      if (error !== undefined) reader.reject(error)
      else reader.resolve({ done: true, value: undefined })
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    let detached = false
    let ownedReader: typeof this.reader
    const detach = () => {
      detached = true
      if (ownedReader && this.reader === ownedReader) { this.reader = undefined; ownedReader.resolve({ done: true, value: undefined }) }
    }
    return {
      next: () => {
        if (detached) return Promise.resolve({ done: true, value: undefined })
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.ended) return this.failure !== undefined
          ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined })
        if (this.reader) return Promise.reject(new Error('Claude queue already has a reader'))
        return new Promise((resolve, reject) => { ownedReader = { resolve, reject }; this.reader = ownedReader })
      },
      // Subscriber closure is distinct from native cancellation/session closure.
      return: async () => { detach(); return { done: true, value: undefined } },
      throw: async (error: unknown) => { detach(); throw error },
    }
  }
}
