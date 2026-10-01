import { OpenCodeNativeDeliveryError, type OpenCodeServerController } from './opencodeTransport.js'

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
  readonly onEvidence?: (evidence: OpenCodeHttpEvidence) => void
}

/** The only SDK fetch boundary. No URLs, credentials or process ownership come from the SDK. */
export function createOpenCodeBoundFetch(options: OpenCodeBoundFetchOptions): typeof fetch {
  const { server, ownerAgentId, directory, generation, signal, onEvidence } = options
  const current = () => (server.generation ?? 0) === generation
    && (server.ownerAgentId === undefined || server.ownerAgentId === ownerAgentId)
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const headerDirectory = request.headers.get('x-opencode-directory')
    const requestedDirectory = url.searchParams.get('directory') ?? (headerDirectory ? decodeURIComponent(headerDirectory) : '')
    if (url.origin !== 'http://opencode.invalid' || requestedDirectory !== directory
      || (headerDirectory !== null && decodeURIComponent(headerDirectory) !== directory)
      || request.headers.has('x-opencode-workspace') || !current()) {
      throw new OpenCodeNativeDeliveryError('OPENCODE_CLIENT_CONTEXT_STALE', 'The native client context is no longer owned.', 'definite')
    }
    if (!url.searchParams.has('directory') && directory) url.searchParams.set('directory', directory)
    request.headers.delete('x-opencode-directory')
    request.headers.delete('authorization')
    const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal
    if (combined.aborted) throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native mutation was canceled before dispatch.', 'definite')
    const body = request.body ? await request.text() : undefined
    if (combined.aborted || !current()) throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native request was invalidated before dispatch.', 'definite')
    const operation = Object.freeze({ method: request.method, path: url.pathname })
    const base = { operation, ownerAgentId, directory, generation, dispatch: 'dispatched' as const, bodyValidity: 'unread' as const }
    let response: Response
    try {
      response = await server.request(url.pathname + url.search, {
        method: request.method, headers: request.headers,
        ...(body !== undefined ? { body } : {}),
      }, combined, generation)
    } catch (error) {
      onEvidence?.(Object.freeze({ ...base, headers: Object.freeze({}) }))
      throw error
    }
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'x-next-cursor']) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    onEvidence?.(Object.freeze({ ...base, status: response.status, headers: Object.freeze(headers) }))
    if (!current() || combined.aborted) {
      await response.body?.cancel().catch(() => undefined)
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native generation or owner lifetime changed after dispatch.', 'uncertain')
    }
    return response
  }
}
export type OpenCodeClientFactory = typeof createOpenCodeBoundFetch
