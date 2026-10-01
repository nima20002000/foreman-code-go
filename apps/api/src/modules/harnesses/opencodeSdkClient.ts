import { OpenCodeNativeDeliveryError } from './opencodeTransport.js'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { classifyOpenCodeDelivery, createOpenCodeBoundFetch, type OpenCodeHttpEvidence, type OpenCodeBoundFetchOptions } from './opencodeClient.js'

/** Client-only qualification candidate. Raw HTTP/SSE remains the production fallback. */
export function createOpenCodeSdkClient(options: OpenCodeBoundFetchOptions) {
  return createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    directory: options.directory,
    fetch: async (input, init) => {
      let evidence: OpenCodeHttpEvidence | undefined
      const response = await createOpenCodeBoundFetch({ ...options, onEvidence: value => {
        evidence = value; options.onEvidence?.(value)
      } })(input, init)
      const raw = evidence
      const validity = (bodyValidity: OpenCodeHttpEvidence['bodyValidity']) => {
        if (raw) options.onEvidence?.(Object.freeze({ ...raw, bodyValidity }))
      }
      // SDK 1.18.31 reads both JSON success and rejection bodies via text().
      // Observe that actual read rather than inferring validity from operation success.
      const read = response.text.bind(response)
      response.text = async () => {
        let text: string
        try { text = await read() }
        catch (error) { validity('invalid'); throw error }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
        const json = !contentType || contentType === 'application/json' || contentType.endsWith('+json')
        if (json || !response.ok) {
          try { if (text || !response.ok) JSON.parse(text); validity('valid') }
          catch { validity(json ? 'invalid' : 'valid') }
        } else validity('valid')
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
  operation: (client: ReturnType<typeof createOpenCodeSdkClient>) => Promise<T>): Promise<T> {
  let evidence: OpenCodeHttpEvidence | undefined
  const client = createOpenCodeSdkClient({ ...options, onEvidence: value => {
    evidence = value
    options.onEvidence?.(value)
  } })
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
