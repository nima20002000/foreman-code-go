import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { access } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

/** Serve the compiled shell on the API origin, preserving API/MCP error responses. */
export async function registerBuiltWeb(app: FastifyInstance, root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('GRAPHQL_WEB_DIST requires an absolute directory.')
  await access(join(root, 'index.html'))
  void app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders(response, path) {
      const cache = path.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable' : 'no-cache'
      response.setHeader('cache-control', cache)
      response.setHeader('x-content-type-options', 'nosniff')
    },
  })
  for (const path of ['/', '/workspaces', '/workspaces/*', '/settings', '/settings/*', '/account', '/terminal']) {
    app.get(path, async (_request, reply) => reply.sendFile('index.html'))
  }
}
