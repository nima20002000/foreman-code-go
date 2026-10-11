import type { FastifyInstance } from 'fastify'
import { ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import type { ProviderAccountsService } from '../modules/provider-accounts/service.js'
import { DomainError } from '../modules/errors.js'

export function registerProviderAccountRoutes(app: FastifyInstance, accounts: ProviderAccountsService): void {
  app.get('/api/provider-accounts', request => accounts.list(requirePrincipal(request)))
  app.get('/api/provider-accounts/page', request => accounts.page(requirePrincipal(request), request.query))
  app.post('/api/provider-accounts/register', request => accounts.register(requirePrincipal(request), 'http', request.body))
  app.post('/api/provider-accounts', request => accounts.create(requirePrincipal(request), 'http', request.body))
  const accountId = (params: unknown) => ProviderAccountIdSchema.parse((params as { accountId: string }).accountId)
  app.get('/api/provider-accounts/:accountId', request => accounts.get(requirePrincipal(request), {
    ...(request.query as object), accountId: accountId(request.params),
  }))
  app.get('/api/provider-accounts/:accountId/models', request => accounts.models(requirePrincipal(request), {
    ...(request.query as object), accountId: accountId(request.params),
  }))
  app.post('/api/provider-accounts/:accountId/remove', request =>
    accounts.remove(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/authentication', request =>
    accounts.prepareAuthentication(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/authentication/status', request =>
    accounts.authenticationStatus(requirePrincipal(request), request.body))
  app.post('/api/provider-accounts/authentication/cancel', request =>
    accounts.cancelAuthentication(requirePrincipal(request), 'http', request.body))
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
  app.post('/api/provider-accounts/:accountId/api-key', async request => {
    const principal = requirePrincipal(request)
    const id = accountId(request.params)
    try { requireLocalHuman(request) } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await accounts.auditDenied(principal, 'http', 'provider.account.key.provision', id)
      }
      throw error
    }
    return accounts.provisionApiKey(principal, id, request.body)
  })
}
