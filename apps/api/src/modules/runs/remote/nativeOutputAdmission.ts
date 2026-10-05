import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../../errors.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'

export async function awaitNativeOutputContext<T>(read: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  for (;;) {
    bounded.throwIfAborted()
    try {
      const result = await read(bounded)
      bounded.throwIfAborted()
      return result
    }
    catch (error) {
      const pending = (error instanceof DomainError || error instanceof DeviceApplicationError)
        && error.code === 'NATIVE_ARTIFACT_CONTEXT_PENDING'
      if (!pending) throw error
    }
    await delay(25, undefined, { signal: bounded })
  }
}
