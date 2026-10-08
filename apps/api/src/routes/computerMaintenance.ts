import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { FleetMaintenanceService } from '../modules/computers/fleet.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerMaintenanceRoutes(app: FastifyInstance, service: FleetMaintenanceService): void {
  app.get('/api/management/computers/maintenance', request => {
    const query = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(request.query)
    return service.list(requirePrincipal(request), 'http', query.refresh === 'true')
  })
  app.post('/api/management/computers/maintenance/start', request =>
    service.start(requirePrincipal(request), 'http', request.body as Parameters<FleetMaintenanceService['start']>[2]))
}
