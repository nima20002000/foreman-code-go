import type { OpenCodeClientFactory } from '../../src/modules/harnesses/opencodeClient.js'
import { createOpenCodeSdkTransport } from '../../src/modules/harnesses/opencodeSdkClient.js'

/** Trace the real selectable SDK transport below the real manager. */
export function sdkQualificationClient(calls: string[]): OpenCodeClientFactory {
  return options => {
    const transport = createOpenCodeSdkTransport(options)
    return (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const name = request.method === 'GET' && url.pathname === '/global/health' ? 'health'
        : request.method === 'POST' && url.pathname === '/session' ? 'create'
          : request.method === 'POST' && parts[0] === 'session' && parts[2] === 'prompt_async' ? 'prompt'
            : request.method === 'GET' && url.pathname === '/permission' ? 'permissions'
              : request.method === 'POST' && parts[0] === 'permission' && parts[2] === 'reply' ? 'reply'
                : request.method === 'GET' && url.pathname === '/session/status' ? 'status'
                  : request.method === 'GET' && parts[0] === 'session' && parts[2] === 'message' ? (parts[3] ? 'message' : 'messages') : undefined
      if (name) calls.push(name)
      return transport(request)
    }
  }
}
