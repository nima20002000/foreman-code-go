import { flockSync } from 'fs-ext'
import { setTimeout as delay } from 'node:timers/promises'

/** Nonblocking kernel attempts keep lock contention off the event loop and libuv worker pool. */
export async function acquireDirectoryLock(fd: number, options: {
  nonBlocking?: boolean
  signal?: AbortSignal | undefined
} = {}): Promise<boolean> {
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      flockSync(fd, 'exnb')
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error
      if (options.nonBlocking) return false
    }
    try {
      await delay(10, undefined, { signal: options.signal })
    } catch (error) {
      options.signal?.throwIfAborted()
      throw error
    }
  }
}
