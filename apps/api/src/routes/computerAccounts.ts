import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ComputerAccountsListInputSchema } from '@foreman-code/contracts/computer-accounts'
import type { ComputerAccountsService } from '../modules/computers/accounts.js'
import { requirePrincipal } from '../modules/access/http.js'

const Query = ComputerAccountsListInputSchema.extend({ refresh: z.enum(['true', 'false']).optional() })
export function registerComputerAccountsRoutes(app: FastifyInstance, service: ComputerAccountsService): void {
  app.get('/api/management/computers/accounts', request => {
    const query = Query.parse(request.query)
    return service.list(requirePrincipal(request), 'http', query.refresh === 'true', query.cursor)
  })
}
