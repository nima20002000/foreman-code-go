import { DeviceApplicationError } from './deviceApplicationError.js'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'

/** Main gets 100 seconds to answer before the device transport's 120-second budget expires.
 * Supported CI waits use chunks of at most 60 seconds. */
const relayDeadlineMs = 100_000
const workerMcpUploadIdleTimeoutMs = 15_000
const minimumUploadBytesPerSecond = 64 * 1024
/** Bound even a continuously progressing upload, allowing the maximum carrier at 64 KiB/s. */
export const workerMcpUploadCeilingMs = workerMcpUploadIdleTimeoutMs + Math.ceil(
  (WORKER_MCP_EXTENSION.maxJsonBytes + WORKER_MCP_EXTENSION.maxBinaryBytes) / minimumUploadBytesPerSecond,
) * 1000

export async function withWorkerMcpDeadline<T>(
  run: (signal: AbortSignal, uploaded: () => void, progress: (acknowledgedBytes: number) => void) => Promise<T>,
  signal?: AbortSignal, options: { uploading?: boolean } = {},
): Promise<T> {
  const deadline = new AbortController()
  let uploadFinished = false
  let acknowledgedBytes = 0
  const expire = () => deadline.abort()
  let timer = setTimeout(expire, options.uploading ? workerMcpUploadIdleTimeoutMs : relayDeadlineMs)
  const ceiling = options.uploading ? setTimeout(expire, workerMcpUploadCeilingMs) : undefined
  const progress = (bytes: number) => {
    if (!options.uploading || uploadFinished || deadline.signal.aborted || bytes <= acknowledgedBytes) return
    acknowledgedBytes = bytes
    clearTimeout(timer)
    timer = setTimeout(expire, workerMcpUploadIdleTimeoutMs)
  }
  const uploaded = () => {
    if (!options.uploading || uploadFinished || deadline.signal.aborted) return
    uploadFinished = true
    clearTimeout(timer)
    clearTimeout(ceiling)
    timer = setTimeout(expire, relayDeadlineMs)
  }
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener('abort', () => reject(new DeviceApplicationError('timeout')), { once: true })
  })
  try {
    return await Promise.race([
      run(signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, uploaded, progress), expired,
    ])
  } finally {
    clearTimeout(timer)
    clearTimeout(ceiling)
  }
}
