import type { FastifyInstance } from 'fastify'
import { ComputerGitHubInputSchema, ComputerGitHubStatusInputSchema } from '@foreman-code/contracts/computer-accounts'
import type { ComputerGitHubService } from '../modules/computers/github.js'
import { requirePrincipal } from '../modules/access/http.js'

export function registerComputerGitHubRoutes(app: FastifyInstance, service: ComputerGitHubService): void {
  app.post('/api/management/computers/github/login', request => {
    const input = ComputerGitHubInputSchema.parse(request.body)
    return service.handle(requirePrincipal(request), 'http', input.target, { operation: 'login-start' })
  })
  app.post('/api/management/computers/github/login/status', request => {
    const input = ComputerGitHubStatusInputSchema.parse(request.body)
    return service.handle(requirePrincipal(request), 'http', input.target, { operation: 'login-status', loginId: input.loginId })
  })
  app.post('/api/management/computers/github/logout', request => {
    const input = ComputerGitHubInputSchema.parse(request.body)
    return service.handle(requirePrincipal(request), 'http', input.target, { operation: 'logout' })
  })
}
