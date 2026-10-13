import { vi } from 'vitest'

/** JSDOM has no Web Locks; keep tab ownership and command serialization in the fixture. */
export function installBrowserLocks() {
  const queues = new Map<string, Promise<unknown>>()
  const held = new Set<string>()
  const browserNavigator = Object.create(navigator) as Navigator
  Object.defineProperty(browserNavigator, 'locks', { configurable: true, value: {
    async request<T>(name: string, options: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
      callback?: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
      const action = typeof options === 'function' ? options : callback!
      const settings = typeof options === 'function' ? {} : options
      if (settings.ifAvailable && held.has(name)) return action(null)
      const preceding = queues.get(name) ?? Promise.resolve()
      const work = preceding.then(async () => {
        settings.signal?.throwIfAborted()
        held.add(name)
        try {
          return await action({ name, mode: 'exclusive' } as Lock)
        } finally {
          held.delete(name)
        }
      })
      queues.set(name, work.then(() => undefined, () => undefined))
      return work
    },
  } })
  vi.stubGlobal('navigator', browserNavigator)
}
