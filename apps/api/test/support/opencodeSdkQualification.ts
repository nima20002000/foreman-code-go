import { createOpenCodeBoundFetch, type OpenCodeClientFactory } from '../../src/modules/harnesses/opencodeClient.js'
import { callOpenCodeSdk } from '../../src/modules/harnesses/opencodeSdkClient.js'

/** Synthetic qualification bridge below the real manager, never a production default.
 * Generated SDK methods handle selected critical HTTP calls. Raw bounded SSE,
 * metadata and history stay with the manager. Small fixtures do not qualify the
 * SDK's response.text() byte budget or an installed native binary.
 */
export function sdkQualificationClient(calls: string[]): OpenCodeClientFactory {
  return options => async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const name = request.method === 'GET' && url.pathname === '/global/health' ? 'health'
      : request.method === 'POST' && url.pathname === '/session' ? 'create'
        : request.method === 'POST' && segments[0] === 'session' && segments[2] === 'prompt_async' ? 'prompt'
          : request.method === 'GET' && url.pathname === '/permission' ? 'permissions'
            : request.method === 'POST' && segments[0] === 'permission' && segments[2] === 'reply' ? 'reply'
              : request.method === 'GET' && url.pathname === '/session/status' ? 'status' : undefined
    if (!name) return createOpenCodeBoundFetch(options)(request)
    calls.push(name)
    let raw: Response | undefined
    const server = new Proxy(options.server, {
      get(target, property) {
        if (property === 'request') return async (...args: Parameters<typeof target.request>) => {
          const response = await target.request(...args)
          raw = response.clone()
          return response
        }
        return Reflect.get(target, property, target)
      },
    })
    const body = request.body ? JSON.parse(await request.text()) as Record<string, unknown> : {}
    try {
      await callOpenCodeSdk<unknown>({ ...options, server }, async client => {
        switch (name) {
          case 'health': return client.global.health()
          case 'create': return client.session.create({ ...body, directory: options.directory } as Parameters<typeof client.session.create>[0])
          case 'prompt': return client.session.promptAsync({ ...body, directory: options.directory, sessionID: segments[1]! } as Parameters<typeof client.session.promptAsync>[0])
          case 'permissions': return client.permission.list({ directory: options.directory })
          case 'reply': return client.permission.reply({ ...body, directory: options.directory, requestID: segments[1]! } as Parameters<typeof client.permission.reply>[0])
          case 'status': return client.session.status({ directory: options.directory })
        }
      })
      if (!raw) throw new Error('SDK qualification did not dispatch the exact operation.')
      return raw
    } catch (error) {
      await raw?.body?.cancel().catch(() => undefined)
      // A lost/invalid ACK is never permission to try the raw mutation instead.
      throw error
    }
  }
}
