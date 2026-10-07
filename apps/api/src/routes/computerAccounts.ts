import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ComputerAccountsService } from '../modules/computers/accounts.js'
import { requirePrincipal } from '../modules/access/http.js'

const Query = z.object({ refresh: z.enum(['true', 'false']).optional() }).strict()
export function registerComputerAccountsRoutes(app: FastifyInstance, service: ComputerAccountsService): void {
  app.get('/api/management/computers/accounts', request =>
    service.list(requirePrincipal(request), 'http', Query.parse(request.query).refresh === 'true'))
}
