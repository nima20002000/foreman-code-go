import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance } from 'fastify'

import { bearerToken } from '../../modules/access/postgres.js'
import { createAppMcpServer } from './server.js'
import type { AppMcpServices } from './types.js'

export function registerAppMcp(app: FastifyInstance, services: AppMcpServices): void {
  app.post('/mcp/tools', { bodyLimit: 1_000_000 }, async (request, reply) => {
    const principal = await services.access.authenticate(bearerToken(request.headers.authorization), 'worker')
    const server = await createAppMcpServer({ principal, interactions: services.interactions })
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp/tools', handler: async (request, reply) => {
      await services.access.authenticate(bearerToken(request.headers.authorization), 'worker')
      return reply.code(405).send({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
      })
    } })
  }
}
