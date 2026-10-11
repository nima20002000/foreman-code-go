import { CiGetOutputSchema, CiLogsInputSchema, CiLogsOutputSchema, CiRunInputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import type { HostCiService } from '../modules/ci-host/service.js'

export function registerHostCiRoutes(app: FastifyInstance, ci: HostCiService): void {
  const root = '/api/management/workspaces/:workspaceId/ci'
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(root, async request =>
    CiRunOutputSchema.parse(await ci.run(requirePrincipal(request), {
      ...CiRunInputSchema.parse(request.body), workspaceId: request.params.workspaceId,
    }, 'http')))
  app.get<{ Params: { workspaceId: string; ticketId: string } }>(`${root}/:ticketId`, async request =>
    CiGetOutputSchema.parse(await ci.get(requirePrincipal(request), request.params)))
  const logsQuery = CiLogsInputSchema.omit({ ticketId: true }).extend({
    afterOffset: z.coerce.number().int().nonnegative().optional(),
    maxBytes: z.coerce.number().int().min(1).max(65_536).optional(),
    group: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  })
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId/logs`, async request =>
    CiLogsOutputSchema.parse(await ci.logs(requirePrincipal(request), {
      ...request.params, ...logsQuery.parse(request.query),
    })))
}
