import {
  BrowserSignInRequestSchema, BrowserSignInResponseSchema,
  OwnerSetupResponseSchema, OwnerSetupStatusSchema,
} from '@graphql/contracts/management'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireLocalRequest } from '../access/http.js'
import { DomainError } from '../errors.js'
import type { BrowserAuthentication } from './service.js'

/** Method-and-path allowlist, never a blanket /api/auth/* exemption. */
export function isPublicBrowserAuthRequest(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0]
  return (request.method === 'GET' && path === '/api/auth/setup')
    || (request.method === 'POST' && ['/api/auth/setup', '/api/auth/sign-in/email', '/api/auth/sign-up/email'].includes(path ?? ''))
}

export function registerBrowserAuthRoutes(app: FastifyInstance, browserAuth?: BrowserAuthentication): void {
  const requireConfigured = () => {
    if (!browserAuth) throw new DomainError('BROWSER_AUTH_NOT_CONFIGURED', 'Set BETTER_AUTH_SECRET and BETTER_AUTH_URL on the API server to enable browser sign-in.', 503)
    return browserAuth
  }
  app.get('/api/auth/setup', async (request, reply) => {
    requireLocalRequest(request)
    reply.header('cache-control', 'no-store')
    return OwnerSetupStatusSchema.parse(await requireConfigured().setupStatus())
  })
  app.post<{ Body: unknown }>('/api/auth/setup', { bodyLimit: 4096 }, async (request, reply) => {
    requireLocalRequest(request)
    reply.header('cache-control', 'no-store')
    const auth = requireConfigured()
    auth.requireMutationOrigin(request)
    await auth.limitAttempt('setup', request)
    await auth.createOwner(request.body)
    return reply.code(201).send(OwnerSetupResponseSchema.parse({ created: true }))
  })
  app.post<{ Body: unknown }>('/api/auth/sign-in/email', { bodyLimit: 4096 }, async (request, reply) => {
    requireLocalRequest(request)
    reply.header('cache-control', 'no-store')
    const auth = requireConfigured()
    auth.requireMutationOrigin(request)
    await auth.limitAttempt('sign-in', request)
    await auth.signIn(request, reply, BrowserSignInRequestSchema.parse(request.body))
    return BrowserSignInResponseSchema.parse({ signedIn: true })
  })
  // The Better Auth instance also sets disableSignUp:true. There is no wildcard route.
  app.post('/api/auth/sign-up/email', async () => {
    throw new DomainError('REGISTRATION_DISABLED', 'Public registration is disabled. Only the one-time owner setup is supported.', 403)
  })
}
