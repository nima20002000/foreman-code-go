import { DeviceApplicationError } from './deviceApplicationError.js'

/** Main gets 100 seconds to answer before the device transport's 120-second budget expires.
 * Supported CI waits use chunks of at most 60 seconds. */
const relayDeadlineMs = 100_000

export async function withWorkerMcpDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), relayDeadlineMs)
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener('abort', () => reject(new DeviceApplicationError('timeout')), { once: true })
  })
  try {
    return await Promise.race([run(signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal), expired])
  } finally { clearTimeout(timer) }
}
