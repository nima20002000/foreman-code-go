import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { createOpenCodeBoundFetch, type OpenCodeBoundFetchOptions } from './opencodeClient.js'

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
