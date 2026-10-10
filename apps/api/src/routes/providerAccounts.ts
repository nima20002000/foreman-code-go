import type { FastifyInstance } from 'fastify'
import { ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import type { ProviderAccountsService } from '../modules/provider-accounts/service.js'

export function registerProviderAccountRoutes(app: FastifyInstance, accounts: ProviderAccountsService): void {
  app.get('/api/provider-accounts', request => accounts.list(requirePrincipal(request)))
  app.post('/api/provider-accounts', request => accounts.create(requirePrincipal(request), 'http', request.body))
  const accountId = (params: unknown) => ProviderAccountIdSchema.parse((params as { accountId: string }).accountId)
  app.patch('/api/provider-accounts/:accountId', request =>
    accounts.rename(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/default', request =>
    accounts.setDefault(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/login', request =>
    accounts.login(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/logout', request =>
    accounts.logout(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/refresh', request =>
    accounts.refresh(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/api-key', request => {
    requireLocalHuman(request)
    return accounts.provisionApiKey(requirePrincipal(request), accountId(request.params), request.body)
  })
}
