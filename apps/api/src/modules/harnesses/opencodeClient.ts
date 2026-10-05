import { OpenCodeNativeDeliveryError, type OpenCodeServerController } from './opencodeTransport.js'
import { openCodeMediaStream } from './opencodeMedia.js'

interface OpenCodeHistoryTransfer {
  source: ReadableStream<Uint8Array>
  settled: Promise<PromiseSettledResult<void>[]>
}
const historyTransfers = new WeakMap<Response, OpenCodeHistoryTransfer>()

async function releaseHistoryTransfer(response: Response): Promise<void> {
  const transfer = historyTransfers.get(response)
  if (!transfer) return
  await transfer.settled
  // A rejected in-flight pipe write can settle shutdown without cancelling its source.
  // Cancelling an errored source repeats the error already reported by the reader.
  await Promise.allSettled([transfer.source.cancel()])
  historyTransfers.delete(response)
}

export interface OpenCodeHttpEvidence {
  readonly operation: { readonly method: string; readonly path: string }
  readonly ownerAgentId: string
  readonly directory: string
  readonly generation: number
  readonly dispatch: 'not_dispatched' | 'dispatched'
  readonly status?: number
  readonly headers: Readonly<Record<string, string>>
  readonly bodyValidity: 'unread' | 'valid' | 'invalid'
}

/** Admission and body validity are separate: malformed accepted responses never authorize resend. */
export function classifyOpenCodeDelivery(evidence: OpenCodeHttpEvidence): 'acknowledged' | 'definite rejection' | 'uncertain' {
  if (evidence.dispatch === 'not_dispatched') return 'definite rejection'
  if (evidence.status === undefined || evidence.status >= 500) return 'uncertain'
  if (evidence.status >= 200 && evidence.status < 300) return 'acknowledged'
  if (evidence.status >= 400 && evidence.status < 500) return 'definite rejection'
  return 'uncertain'
}

export interface OpenCodeBoundFetchOptions {
  readonly server: OpenCodeServerController
  readonly ownerAgentId: string
  readonly directory: string
  readonly generation: number
  readonly signal?: AbortSignal
  /** Owner closure is distinct from a canceled observer; accepted HTTP facts survive detachment. */
  readonly ownerSignal?: AbortSignal
  readonly onEvidence?: (evidence: OpenCodeHttpEvidence) => void
}

/** The only SDK fetch boundary. No URLs, credentials or process ownership come from the SDK. */
export function createOpenCodeBoundFetch(options: OpenCodeBoundFetchOptions): typeof fetch {
  const { server, ownerAgentId, directory, generation, signal, onEvidence } = options
  const ownerSignal = options.ownerSignal ?? signal
  const current = () => (server.generation ?? 0) === generation
    && (server.ownerAgentId === undefined || server.ownerAgentId === ownerAgentId)
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const operation = Object.freeze({ method: request.method, path: url.pathname })
    const base = { operation, ownerAgentId, directory, generation, bodyValidity: 'unread' as const }
    const refused = () => onEvidence?.(Object.freeze({ ...base, dispatch: 'not_dispatched', headers: Object.freeze({}) }))
    const headerDirectory = request.headers.get('x-opencode-directory')
    const requestedDirectory = url.searchParams.get('directory') ?? (headerDirectory ? decodeURIComponent(headerDirectory) : '')
    if (url.origin !== 'http://opencode.invalid' || requestedDirectory !== directory
      || (headerDirectory !== null && decodeURIComponent(headerDirectory) !== directory)
      || request.headers.has('x-opencode-workspace') || !current()) {
      refused()
      throw new OpenCodeNativeDeliveryError('OPENCODE_CLIENT_CONTEXT_STALE', 'The native client context is no longer owned.', 'definite')
    }
    if (!url.searchParams.has('directory') && directory) url.searchParams.set('directory', directory)
    request.headers.delete('x-opencode-directory')
    request.headers.delete('authorization')
    const combined = AbortSignal.any([request.signal, ...(signal ? [signal] : []), ...(ownerSignal ? [ownerSignal] : [])])
    if (combined.aborted) {
      refused()
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native mutation was canceled before dispatch.', 'definite')
    }
    const body = request.body ? await request.text() : undefined
    if (combined.aborted || !current()) {
      refused()
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native request was invalidated before dispatch.', 'definite')
    }
    let response: Response
    try {
      response = await server.request(url.pathname + url.search, {
        method: request.method, headers: request.headers,
        ...(body !== undefined ? { body } : {}),
      }, combined, generation)
    } catch (error) {
      const notDispatched = error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite'
        && ['OPENCODE_SERVER_GENERATION_CHANGED', 'OPENCODE_CLIENT_CONTEXT_STALE', 'OPENCODE_NATIVE_NOT_DISPATCHED'].includes(error.code)
      onEvidence?.(Object.freeze({ ...base, dispatch: notDispatched ? 'not_dispatched' : 'dispatched', headers: Object.freeze({}) }))
      throw error
    }
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'x-next-cursor']) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    onEvidence?.(Object.freeze({ ...base, dispatch: 'dispatched', status: response.status, headers: Object.freeze(headers) }))
    if (!current() || ownerSignal?.aborted) {
      await response.body?.cancel().catch(() => undefined)
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native generation or owner lifetime changed after dispatch.', 'uncertain')
    }
    const history = request.method === 'GET' && /^\/session\/[^/]+\/message(?:\/[^/]+)?$/.test(url.pathname)
    if (history && response.ok && response.body) {
      const headers = new Headers(response.headers)
      headers.delete('content-length')
      const media = openCodeMediaStream()
      const projected = new Response(media.readable, {
        status: response.status, statusText: response.statusText, headers,
      })
      // Response may wrap its input stream; bind cleanup to the returned response.
      historyTransfers.set(projected, { source: response.body,
        settled: Promise.allSettled([response.body.pipeTo(media.writable, { signal: combined })]),
      })
      return projected
    }
    return response
  }
}
export type OpenCodeClientFactory = typeof createOpenCodeBoundFetch

export const OPENCODE_HTTP_BODY_LIMIT = 8_000_000

export class OpenCodeResponseTooLargeError extends Error {
  constructor() {
    super('OpenCode response exceeds the bounded native page buffer.')
    this.name = 'OpenCodeResponseTooLargeError'
  }
}

/** Keep generated SDK text parsing inside the same native-page byte budget. */
export async function readOpenCodeResponseText(response: Response, ownerSignal?: AbortSignal): Promise<string> {
  const signal = ownerSignal ? AbortSignal.any([ownerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  if (signal.aborted) {
    await response.body?.cancel().catch(() => undefined)
    await releaseHistoryTransfer(response)
    signal.throwIfAborted()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > OPENCODE_HTTP_BODY_LIMIT) throw new OpenCodeResponseTooLargeError()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    await releaseHistoryTransfer(response)
    reader.releaseLock()
  }
}
