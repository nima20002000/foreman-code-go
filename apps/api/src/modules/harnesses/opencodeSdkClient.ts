import { OpenCodeNativeDeliveryError } from './opencodeTransport.js'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { classifyOpenCodeDelivery, createOpenCodeBoundFetch, readOpenCodeResponseText, type OpenCodeHttpEvidence, type OpenCodeBoundFetchOptions, type OpenCodeClientFactory } from './opencodeClient.js'

/** Client-only qualification candidate. Raw HTTP/SSE remains the production fallback. */
export function createOpenCodeSdkClient(options: OpenCodeBoundFetchOptions, capture?: (response: Response, text?: string) => void) {
  return createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    directory: options.directory,
    fetch: async (input, init) => {
      let evidence: OpenCodeHttpEvidence | undefined
      const response = await createOpenCodeBoundFetch({ ...options, onEvidence: value => {
        evidence = value; options.onEvidence?.(value)
      } })(input, init)
      capture?.(response)
      const raw = evidence
      const validity = (bodyValidity: OpenCodeHttpEvidence['bodyValidity']) => {
        if (raw) options.onEvidence?.(Object.freeze({ ...raw, bodyValidity }))
      }
      // SDK 1.18.31 reads both JSON success and rejection bodies via text().
      // Observe that actual read rather than inferring validity from operation success.
      response.text = async () => {
        let text: string
        try { text = await readOpenCodeResponseText(response, options.ownerSignal ?? options.signal) }
        catch (error) { validity('invalid'); throw error }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
        const json = !contentType || contentType === 'application/json' || contentType.endsWith('+json')
        let bodyValidity: OpenCodeHttpEvidence['bodyValidity'] = 'valid'
        if (json || !response.ok) {
          try { if (text || !response.ok) JSON.parse(text) }
          catch { if (json) bodyValidity = 'invalid' }
        }
        validity(bodyValidity)
        if ((options.server.generation ?? 0) !== options.generation || (options.ownerSignal ?? options.signal)?.aborted) {
          throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native owner changed while the SDK response was read.', 'uncertain')
        }
        capture?.(response, text)
        return text
      }
      return response
    },
    responseStyle: 'fields',
    throwOnError: true,
  })
}

/** Keep acceptance evidence outside generated parsing/validation for a single SDK operation. */
export async function callOpenCodeSdk<T>(options: OpenCodeBoundFetchOptions,
  operation: (client: ReturnType<typeof createOpenCodeSdkClient>) => Promise<T>,
  capture?: (response: Response, text?: string) => void): Promise<T> {
  let evidence: OpenCodeHttpEvidence | undefined
  const client = createOpenCodeSdkClient({ ...options, onEvidence: value => {
    evidence = value
    options.onEvidence?.(value)
  } }, capture)
  try {
    return await operation(client)
  }
  catch (error) {
    if (evidence && !['GET', 'HEAD'].includes(evidence.operation.method)
      && error instanceof Error && !(error instanceof OpenCodeNativeDeliveryError)) {
      if (classifyOpenCodeDelivery(evidence) === 'definite rejection') {
        throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_REJECTED',
          'The native SDK operation was rejected by the provider.', 'definite', { cause: error })
      }
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN',
        'The native SDK operation was dispatched but its parsed acknowledgement is unavailable.', 'uncertain', { cause: error })
    }
    throw error
  }
}

/** Explicit SDK selection below the real manager. Unmapped native metadata/SSE
 * stays raw; a dispatched SDK operation never falls back or retries. */
export const createOpenCodeSdkTransport: OpenCodeClientFactory = options => async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const headerDirectory = request.headers.get('x-opencode-directory')
  const directory = url.searchParams.get('directory') ?? (headerDirectory ? decodeURIComponent(headerDirectory) : '')
  if (url.origin !== 'http://opencode.invalid' || directory !== options.directory
    || (headerDirectory !== null && decodeURIComponent(headerDirectory) !== options.directory)
    || request.headers.has('x-opencode-workspace')) return createOpenCodeBoundFetch(options)(request)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const session = parts[0] === 'session' && parts[1] && parts[1] !== 'status'
  const name = request.method === 'GET' && url.pathname === '/global/health' ? 'health'
    : request.method === 'GET' && url.pathname === '/provider' ? 'providers'
      : request.method === 'GET' && url.pathname === '/permission' ? 'permissions'
        : request.method === 'GET' && url.pathname === '/mcp' ? 'mcp'
          : request.method === 'POST' && url.pathname === '/session' ? 'create'
            : request.method === 'GET' && url.pathname === '/session/status' ? 'status'
              : request.method === 'POST' && parts.length === 3 && parts[0] === 'permission' && parts[2] === 'reply' ? 'reply'
                : request.method === 'POST' && parts.length === 3 && parts[0] === 'mcp' && ['connect', 'disconnect'].includes(parts[2] ?? '') ? parts[2]
                  : session && parts.length === 2 && request.method === 'GET' ? 'get'
                    : session && parts.length === 2 && request.method === 'DELETE' ? 'delete'
                      : session && parts.length === 2 && request.method === 'PATCH' ? 'update'
                        : session && request.method === 'GET' && [3, 4].includes(parts.length) && parts[2] === 'message' ? (parts[3] ? 'message' : 'messages')
                          : session && request.method === 'POST' && parts.length === 3 && ['prompt_async', 'abort', 'fork', 'summarize'].includes(parts[2] ?? '') ? parts[2] : undefined
  if (!name || [...url.searchParams.keys()].some(key => key !== 'directory' && !(name === 'messages' && ['limit', 'before'].includes(key)))) {
    return createOpenCodeBoundFetch(options)(request)
  }
  const payload = request.body ? await request.text() : undefined
  const body = payload ? JSON.parse(payload) as Record<string, unknown> : {}
  if (name === 'update' && !Object.keys(body).every(key => ['permission', 'title', 'metadata', 'time'].includes(key))) {
    return createOpenCodeBoundFetch(options)(request.url, { method: request.method, headers: request.headers, signal: request.signal, body: payload ?? '' })
  }
  let response: Response | undefined
  let text: string | undefined
  const current = () => (options.server.generation ?? 0) === options.generation
    && (options.server.ownerAgentId === undefined || options.server.ownerAgentId === options.ownerAgentId)
    && !(options.ownerSignal ?? options.signal)?.aborted
  try {
    await callOpenCodeSdk<unknown>(options, async client => {
      const read = { directory: options.directory }
      const selected = { ...read, sessionID: parts[1]! }
      const fields = { throwOnError: false } as const
      switch (name) {
        case 'health': return client.global.health(fields)
        case 'providers': return client.provider.list(read, fields)
        case 'permissions': return client.permission.list(read, fields)
        case 'mcp': return client.mcp.status(read, fields)
        case 'create': return client.session.create({ ...body, ...read } as Parameters<typeof client.session.create>[0], fields)
        case 'status': return client.session.status(read, fields)
        case 'reply': return client.permission.reply({ ...body, ...read, requestID: parts[1]! } as Parameters<typeof client.permission.reply>[0], fields)
        case 'connect': return client.mcp.connect({ ...read, name: parts[1]! }, fields)
        case 'disconnect': return client.mcp.disconnect({ ...read, name: parts[1]! }, fields)
        case 'get': return client.session.get(selected, fields)
        case 'delete': return client.session.delete(selected, fields)
        case 'update': return client.session.update({ ...body, ...selected } as Parameters<typeof client.session.update>[0], fields)
        case 'prompt_async': return client.session.promptAsync({ ...body, ...selected } as Parameters<typeof client.session.promptAsync>[0], fields)
        case 'summarize': return client.session.summarize({ ...body, ...selected } as Parameters<typeof client.session.summarize>[0], fields)
        case 'abort': return client.session.abort(selected, fields)
        case 'fork': return client.session.fork({ ...body, ...selected }, fields)
        case 'message': return client.session.message({ ...selected, messageID: parts[3]! }, fields)
        case 'messages': return client.session.messages({ ...selected,
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.get('before') ? { before: url.searchParams.get('before')! } : {}),
        }, fields)
      }
    }, (native, payload) => { response = native; if (payload !== undefined) text = payload })
    if (!response || !current()) throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The SDK native owner changed before response adoption.', 'uncertain')
    return new Response(response.status === 204 || response.status === 304 ? null : text ?? '',
      { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined)
    // Preserve definite HTTP read rejection (including exact 404) even when the
    // SDK rejects an unsupported error content type before decoding its body.
    if (response && !response.ok && current() && !(error instanceof OpenCodeNativeDeliveryError && error.certainty === 'uncertain')) {
      return new Response(text ?? '', { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    throw error
  }
}
