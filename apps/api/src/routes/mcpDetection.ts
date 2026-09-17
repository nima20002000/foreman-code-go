import { AgentHarnessSchema, ExecutionLocationSchema, ScopedMcpDetectionSchema } from '@graphql/contracts'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'

import { requirePrincipal } from '../modules/access/http.js'
import { requireAuthorization } from '../modules/access/policy.js'
import { DomainError } from '../modules/errors.js'
import type { McpDetectionService } from '../modules/harnesses/mcpDetection.js'

export function registerMcpDetectionRoute(
  app: FastifyInstance,
  pool: pg.Pool,
  detection: McpDetectionService,
): void {
  app.get<{ Params: { workspaceId: string; harness: string } }>(
    '/api/management/workspaces/:workspaceId/harnesses/:harness/mcp-detection',
    async (request, reply) => {
      const params = z.object({ workspaceId: z.string().trim().min(1), harness: AgentHarnessSchema }).strict().parse(request.params)
      const principal = requirePrincipal(request)
      const resource = { workspaceId: params.workspaceId }
      requireAuthorization(principal, 'harnesses:read', resource)
      requireAuthorization(principal, 'workspace_locations:read', resource)
      const controller = new AbortController()
      const abandoned = () => controller.abort(new Error('MCP detection request abandoned.'))
      const closed = () => { if (!reply.raw.writableEnded) abandoned() }
      request.raw.once('aborted', abandoned)
      reply.raw.once('close', closed)
      try {
        if (request.raw.aborted || reply.raw.destroyed) abandoned()
        controller.signal.throwIfAborted()
        const result = await pool.query<{ execution_location: unknown }>(
          'select execution_location from workspaces where id=$1 and archived_at is null', [params.workspaceId],
        )
        const raw = result.rows[0]?.execution_location
        if (!raw) throw new DomainError('WORKSPACE_LOCATION_UNCONFIGURED', 'The workspace has no configured execution location.', 409)
        const location = ExecutionLocationSchema.parse(raw)
        return ScopedMcpDetectionSchema.parse(await detection.inspect({
          harness: params.harness, runnerId: location.runnerId, workingDirectory: location.rootPath,
          signal: controller.signal,
        }))
      } finally {
        request.raw.removeListener('aborted', abandoned)
        reply.raw.removeListener('close', closed)
      }
    },
  )
}
