import { DeviceApplicationError } from './deviceApplicationError.js'

/** Main gets 100 seconds to answer before the device transport's 120-second budget expires.
 * Supported CI waits use chunks of at most 60 seconds. */
const relayDeadlineMs = 100_000
export const workerMcpUploadDeadlineMs = 15_000

export async function withWorkerMcpDeadline<T>(
  run: (signal: AbortSignal, uploaded: () => void) => Promise<T>,
  signal?: AbortSignal, options: { uploading?: boolean } = {},
): Promise<T> {
  const deadline = new AbortController()
  let uploadFinished = false
  let timer = setTimeout(() => deadline.abort(), options.uploading ? workerMcpUploadDeadlineMs : relayDeadlineMs)
  const uploaded = () => {
    if (!options.uploading || uploadFinished || deadline.signal.aborted) return
    uploadFinished = true
    clearTimeout(timer)
    timer = setTimeout(() => deadline.abort(), relayDeadlineMs)
  }
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener('abort', () => reject(new DeviceApplicationError('timeout')), { once: true })
  })
  try {
    return await Promise.race([run(signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, uploaded), expired])
  } finally { clearTimeout(timer) }
}
