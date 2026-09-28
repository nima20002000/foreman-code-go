import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { ManagementAudience } from '@graphql/contracts/management'
import type { FastifyInstance } from 'fastify'

import { requireLocalRequest } from '../../modules/access/http.js'
import { bearerToken, type PostgresAccessService } from '../../modules/access/postgres.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'
import { retiredExecutionToolCall } from '../operator/retiredExecutionTools.js'
import { unavailableCurrentWorkflowToolCall } from '../operator/tools/currentWorkflow.js'
import { unavailableRunGraphToolCall } from '../operator/tools/runGraph.js'
import { unavailableRunInspectionToolCall } from '../operator/tools/runInspection.js'
import { unavailableRunToolCall } from '../operator/tools/runs.js'
import type { OperatorServices } from '../operator/types.js'
import type { McpRole } from './roles.js'
import { createGraphqlMcpServer, roleDeniedToolCall } from './server.js'

export const GRAPHQL_MCP_PATH = '/mcp'

export interface GraphqlMcpServices {
  access: PostgresAccessService
  /** Serves Operator credentials. */
  operator?: OperatorServices
  /** Serves Worker credentials (Orchestrator and Coder Agents). */
  interactions?: AppInteractionService
}

/** The single, stateless GraphQL MCP endpoint. The bearer credential decides the role. */
export function registerGraphqlMcp(app: FastifyInstance, services: GraphqlMcpServices): void {
  const audiences: ManagementAudience[] = [
    ...(services.operator ? ['operator' as const] : []), ...(services.interactions ? ['worker' as const] : []),
  ]
  app.post(GRAPHQL_MCP_PATH, { bodyLimit: 1_000_000 }, async (request, reply) => {
    requireLocalRequest(request)
    const principal = await services.access.authenticate(bearerToken(request.headers.authorization), audiences)
    const access = principal.audience === 'operator' ? undefined : await services.interactions!.toolAccess(principal)
    const role: McpRole = access?.role ?? 'operator'
    if (role === 'operator' && services.operator) {
      const context = { principal, services: services.operator }
      // Retired execution tools and unlisted current writes still need authenticated denial audit,
      // rather than disappearing into the SDK's generic unknown-tool response.
      const unavailable = await retiredExecutionToolCall(context, request.body)
        ?? await unavailableRunToolCall(context, request.body)
        ?? await unavailableCurrentWorkflowToolCall(context, request.body)
        ?? await unavailableRunGraphToolCall(context, request.body)
        ?? await unavailableRunInspectionToolCall(context, request.body)
      if (unavailable) return reply.send(unavailable)
    }
    const context = { role, principal, ...(access ? { tools: access.tools } : {}),
      ...(services.operator ? { operator: services.operator } : {}),
      ...(services.interactions ? { interactions: services.interactions } : {}) }
    const denied = await roleDeniedToolCall(context, request.body)
    if (denied) return reply.send(denied)
    const server = await createGraphqlMcpServer(context)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: GRAPHQL_MCP_PATH, handler: async (request, reply) => {
      requireLocalRequest(request)
      await services.access.authenticate(bearerToken(request.headers.authorization), audiences)
      return reply.code(405).send({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
      })
    } })
  }
}
