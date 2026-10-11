import { CiGetOutputSchema, CiRunInputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
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
}
