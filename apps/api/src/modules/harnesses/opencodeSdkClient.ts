import { OpenCodeNativeDeliveryError } from './opencodeTransport.js'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { classifyOpenCodeDelivery, createOpenCodeBoundFetch, type OpenCodeHttpEvidence, type OpenCodeBoundFetchOptions } from './opencodeClient.js'

/** Client-only qualification candidate. Raw HTTP/SSE remains the production fallback. */
export function createOpenCodeSdkClient(options: OpenCodeBoundFetchOptions) {
  return createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    directory: options.directory,
    fetch: createOpenCodeBoundFetch(options),
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
    const result = await operation(client)
    if (evidence) options.onEvidence?.(Object.freeze({ ...evidence, bodyValidity: 'valid' }))
    return result
  }
  catch (error) {
    if (evidence) options.onEvidence?.(Object.freeze({ ...evidence, bodyValidity: 'invalid' }))
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
