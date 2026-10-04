import type { FastifyInstance } from 'fastify'
import { BuildComputerReadSchema, BuildComputerUpdateSchema } from '@graphql/contracts/build-computers'
import { requirePrincipal } from '../modules/access/http.js'
import type { BuildComputerSettings } from '../modules/settings/buildComputers.js'

export function registerBuildComputerRoutes(app: FastifyInstance, service: BuildComputerSettings): void {
  app.post('/api/management/settings/build-computers/read', request =>
    service.read(requirePrincipal(request), BuildComputerReadSchema.parse(request.body)))
  app.post('/api/management/settings/build-computers/update', request =>
    service.update(requirePrincipal(request), 'http', BuildComputerUpdateSchema.parse(request.body)))
}
