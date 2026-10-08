import type { FastifyInstance } from 'fastify'
import { ComputerDriveCompleteInputSchema, ComputerDriveInputSchema, ComputerDriveStatusInputSchema } from '@foreman-code/contracts/computer-accounts'
import type { ComputerDriveService } from '../modules/computers/drive.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerDriveRoutes(app: FastifyInstance, service: ComputerDriveService): void {
  app.post('/api/management/computers/drive/connect', request =>
    service.connectStart(requirePrincipal(request), 'http', ComputerDriveInputSchema.parse(request.body).target))
  app.post('/api/management/computers/drive/connect/status', request => {
    const input = ComputerDriveStatusInputSchema.parse(request.body)
    return service.connectStatus(requirePrincipal(request), 'http', input.target, input.loginId)
  })
  app.post('/api/management/computers/drive/connect/complete', request => {
    const input = ComputerDriveCompleteInputSchema.parse(request.body)
    return service.connectComplete(requirePrincipal(request), 'http', input.target, input.loginId, input.token)
  })
  app.post('/api/management/computers/drive/connect/cancel', request => {
    const input = ComputerDriveStatusInputSchema.parse(request.body)
    return service.cancel(requirePrincipal(request), 'http', input.target, input.loginId)
  })
  app.post('/api/management/computers/drive/disconnect', request =>
    service.disconnect(requirePrincipal(request), 'http', ComputerDriveInputSchema.parse(request.body).target))
}
