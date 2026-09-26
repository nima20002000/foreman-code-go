import { unavailableRunInspectionToolCall } from './tools/runInspection.js'
import { unavailableRunGraphToolCall } from './tools/runGraph.js'
import { unavailableCurrentWorkflowToolCall } from './tools/currentWorkflow.js'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { FastifyInstance } from 'fastify'

import { bearerToken, type PostgresAccessService } from '../../modules/access/postgres.js'
import { requireLocalRequest } from '../../modules/access/http.js'
import { createOperatorMcpServer } from './server.js'
import { retiredExecutionToolCall } from './retiredExecutionTools.js'
import { unavailableManualRunToolCall } from './tools/runs.js'
import type { OperatorServices } from './types.js'

export function registerOperatorMcp(
  app: FastifyInstance,
  access: PostgresAccessService,
  services: OperatorServices,
): void {
  app.post('/mcp/operator', { bodyLimit: 1_000_000 }, async (request, reply) => {
    requireLocalRequest(request)
    const principal = await access.authenticate(bearerToken(request.headers.authorization), 'operator')
    // Retired execution tools and unlisted current writes still need authenticated denial audit,
    // rather than disappearing into the SDK's generic unknown-tool response.
    const unavailable = await retiredExecutionToolCall({ principal, services }, request.body)
      ?? await unavailableManualRunToolCall({ principal, services }, request.body)
      ?? await unavailableCurrentWorkflowToolCall({ principal, services }, request.body)
      ?? await unavailableRunGraphToolCall({ principal, services }, request.body)
      ?? await unavailableRunInspectionToolCall({ principal, services }, request.body)
    if (unavailable) return reply.send(unavailable)
    const server = createOperatorMcpServer({ principal, services })
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp/operator', handler: async (request, reply) => {
      requireLocalRequest(request)
      await access.authenticate(bearerToken(request.headers.authorization), 'operator')
      return reply.code(405).send({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
      })
    } })
  }
}
