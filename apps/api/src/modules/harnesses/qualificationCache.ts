interface Entry<T> { expiresAt: number; pending: boolean; fulfilled: boolean; invalidated: boolean; value: Promise<T>; stale?: Promise<T> | undefined }
/** Bounded single-flight cache. Invalidating a running probe never duplicates its process. */
export class QualificationCache<T> {
  private readonly values = new Map<string, Entry<T>>()
  private closing = false
  constructor(private readonly ttlMs = 300_000, private readonly maximum = 128, private readonly now = Date.now,
    // Serve an expired success while one refresh runs; failures and invalidation never serve stale values.
    private readonly staleWhileRevalidate = false) {
    if (ttlMs < 0 || maximum < 1) throw new Error('Invalid qualification cache limits.')
  }
  get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Native checks are shutting down.'))
    let entry = this.values.get(key)
    let stale: Promise<T> | undefined
    if (entry && !entry.pending && entry.expiresAt <= this.now()) {
      if (this.staleWhileRevalidate && entry.fulfilled) stale = entry.value
      this.values.delete(key)
      entry = undefined
    }
    if (!entry) {
      if (this.values.size >= this.maximum) {
        const settled = [...this.values].find(([, candidate]) => !candidate.pending)
        if (!settled) return Promise.reject(new Error('Native checks are busy.'))
        this.values.delete(settled[0])
      }
      entry = { expiresAt: Infinity, pending: true, fulfilled: false, invalidated: false, value: Promise.resolve().then(load), stale }
      this.values.set(key, entry)
      const loaded = entry
      const settle = (ttl: number, fulfilled: boolean) => {
        loaded.pending = false
        loaded.fulfilled = fulfilled
        loaded.stale = undefined
        loaded.expiresAt = this.now() + ttl
        if (loaded.invalidated && this.values.get(key) === loaded) this.values.delete(key)
      }
      void loaded.value.then(() => settle(this.ttlMs, true), () => settle(Math.min(this.ttlMs, 15_000), false))
    }
    const selected = entry
    if (selected.pending && selected.stale) return selected.stale.then((value) => structuredClone(value))
    return selected.value.then(
      (value) => selected.invalidated ? this.get(key, load) : structuredClone(value),
      (error: unknown) => { if (selected.invalidated) return this.get(key, load); throw error },
    )
  }
  /** Drop one settled result so the next read loads again; a running load keeps its ownership. */
  forget(key: string): void {
    if (this.values.get(key)?.pending === false) this.values.delete(key)
  }
  clear(): void {
    for (const [key, entry] of this.values) {
      entry.stale = undefined
      if (entry.pending) entry.invalidated = true
      else this.values.delete(key)
    }
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.values.values()].map((entry) => entry.value))
    this.values.clear()
  }
}
