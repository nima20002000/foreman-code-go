import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  GraphIdSchema, GraphSequenceSchema, RUN_GRAPH_ROUTES,
  RunGraphHttpSnapshotQuerySchema, RunGraphHttpEventsQuerySchema,
} from '@graphql/contracts/wave25'
import type { RunGraphReadApi } from '../modules/run-graph/readService.js'
import { RunGraphError, runGraphErrorResponse, runGraphErrorStatus } from '../modules/run-graph/errors.js'

const Params = z.object({ workspaceId: GraphIdSchema, workflowId: GraphIdSchema, runId: GraphIdSchema }).strict()
export type GraphHttpDenialAudit = (principalId: string | undefined, code: string, route: string) => Promise<void>

/** Register ONLY after the existing Operator HTTP authentication/security hook. */
export function registerRunGraphRoutes(app: FastifyInstance, reads: RunGraphReadApi, recordDenied: GraphHttpDenialAudit): void {
  const invoke = async (request: FastifyRequest, reply: FastifyReply, route: string, work: () => Promise<unknown> | unknown) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie')
    try {
      if (!request.operatorPrincipal) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
      return await work()
    } catch (error) {
      const safe = error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      if (safe.code === 'GRAPH_READ_ACCESS_DENIED') {
        await recordDenied(request.operatorPrincipal?.id, safe.code, route).catch(() => undefined)
      }
      return reply.code(runGraphErrorStatus(safe.code)).send(runGraphErrorResponse(safe))
    }
  }
  app.get(RUN_GRAPH_ROUTES.capabilities, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.capabilities,
    () => reads.capabilities(request.operatorPrincipal!)))
  app.get(RUN_GRAPH_ROUTES.snapshot, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.snapshot, () => {
    const parameters = Params.safeParse(request.params), query = RunGraphHttpSnapshotQuerySchema.safeParse(request.query)
    if (!parameters.success || !query.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    return reads.snapshot(request.operatorPrincipal!, { protocolVersion: 1, scope: {
      ...parameters.data, workflowVersionId: query.data.workflowVersionId,
      executionSemanticsVersion: Number(query.data.executionSemanticsVersion),
    } })
  }))
  app.get(RUN_GRAPH_ROUTES.events, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.events, () => {
    const parameters = Params.safeParse(request.params), query = RunGraphHttpEventsQuerySchema.safeParse(request.query)
    const cursor = typeof request.query === 'object' && request.query !== null && 'afterSequence' in request.query
      ? request.query.afterSequence : undefined
    if (!GraphSequenceSchema.safeParse(cursor).success) throw new RunGraphError('GRAPH_INVALID_CURSOR')
    if (!parameters.success || !query.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    return reads.events(request.operatorPrincipal!, { protocolVersion: 1, afterSequence: query.data.afterSequence, scope: {
      ...parameters.data, workflowVersionId: query.data.workflowVersionId,
      executionSemanticsVersion: Number(query.data.executionSemanticsVersion),
    } })
  }))
}
