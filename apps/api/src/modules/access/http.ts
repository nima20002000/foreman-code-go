import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { BrowserAccessSessionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from './policy.js'
import { bearerToken, type PostgresAccessService } from './postgres.js'
import { DomainError } from '../errors.js'
import { isPublicBrowserAuthRequest } from '../browser-auth/routes.js'
import { appendAuthCookies, type BrowserAuthentication } from '../browser-auth/service.js'
import type { LocalDevBrowserAccess } from './localDevBrowser.js'

declare module 'fastify' {
  interface FastifyRequest {
    operatorPrincipal?: ManagementPrincipal
    operatorAuthentication?: 'browser' | 'bearer'
    reauthorizeOperator?: () => Promise<ManagementPrincipal>
    browserAccount?: { name: string; email: string }
    operatorLocalDev?: boolean
  }
}

const COOKIE_NAME = 'graphql_operator'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function requireLocalRequest(request: FastifyRequest): void {
  if (!LOOPBACK_HOSTS.has(request.hostname)) throw new DomainError('HOST_NOT_ALLOWED', 'The request Host is not allowed.', 403)
  const origin = request.headers.origin
  if (!origin) return
  let url: URL
  try { url = new URL(origin) } catch { throw new DomainError('ORIGIN_NOT_ALLOWED', 'The request Origin is invalid.', 403) }
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new DomainError('ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403)
}

function cookieToken(value: string | undefined): string | undefined {
  const item = value?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))
  if (!item) return undefined
  try {
    return decodeURIComponent(item.slice(COOKIE_NAME.length + 1))
  } catch {
    throw new DomainError('AUTH_INVALID', 'The Operator session cookie is malformed.', 401)
  }
}

function actionFor(request: FastifyRequest) {
  const url = request.url.split('?')[0] ?? request.url
  if (url === '/api/devices' || url === '/api/devices/main' || url === '/api/devices/setup-options') return 'settings:read' as const
  if (url === '/api/devices/pairing-grants' || url === '/api/devices/revoke' || url === '/api/devices/setup-codes') return 'settings:update' as const
  if (/^\/api\/workspaces\/[^/]+\/reference-files(?:\/|$)/.test(url)) {
    return request.method === 'GET' ? 'workspaces:read' as const : 'workspaces:update' as const
  }
  if (/^\/api\/workspaces\/[^/]+\/workflows\/[^/]+\/reference-files(?:\/|$)/.test(url)) {
    return request.method === 'GET' ? 'workflows:read' as const : 'workflows:update' as const
  }
  if (url.startsWith('/api/operator/conversations')) {
    if (['GET', 'HEAD'].includes(request.method)) return 'operator_chat:read' as const
    // Upload IDs are data, not chat actions (for example: uploads/cancel or uploads/responses).
    if (/^\/api\/operator\/conversations\/[^/]+\/files(?:\/|$)/.test(url)) return 'operator_chat:write' as const
    if (url.endsWith('/cancel')) return 'operator_chat:cancel' as const
    if (url.endsWith('/responses')) return 'operator_chat:respond' as const
    return 'operator_chat:write' as const
  }
  if (/^\/api\/workspaces\/[^/]+\/agent-chat(?:\/|$)/.test(url)) {
    if (['GET', 'HEAD'].includes(request.method)) return 'agent_chat:read' as const
    if (url.endsWith('/interrupt') || url.endsWith('/cancel')) return 'agent_chat:cancel' as const
    if (url.endsWith('/responses')) return 'agent_chat:respond' as const
    return 'agent_chat:write' as const
  }
  if (url === '/api/settings/agents' || url === '/api/settings/workflows') return request.method === 'GET' ? 'settings:read' as const : 'settings:update' as const
  if (url === '/api/settings/harnesses') return request.method === 'GET' ? 'harnesses:read' as const : 'harnesses:update' as const
  if (url.includes('/agents')) return request.method === 'GET' ? 'agents:read' as const : 'graph:edit' as const
  if (url.includes('/runs/') && url.endsWith('/cancel')) return 'runs:stop' as const
  if (url.includes('/runs')) return request.method === 'GET' ? 'runs:read' as const : 'runs:start' as const
  if (url.includes('/workflows/') || url.endsWith('/graph')) return request.method === 'GET' ? 'workflows:read' as const : 'graph:save' as const
  if (url.includes('/workspaces/')) return 'workspaces:read' as const
  return 'capabilities:read' as const
}

export function requirePrincipal(request: FastifyRequest): ManagementPrincipal {
  if (!request.operatorPrincipal) throw new DomainError('AUTH_REQUIRED', 'An authenticated Operator principal is required.', 401)
  return request.operatorPrincipal
}

/** Browser-only actions depend on verified authentication, never cookie names. */
export function requireBrowserSession(request: FastifyRequest): void {
  requirePrincipal(request)
  if (request.operatorAuthentication !== 'browser') {
    throw new DomainError('MCP_BROWSER_REVIEW_REQUIRED', 'Review this change in the signed-in browser.', 403)
  }
}

export function registerOperatorHttpSecurity(app: FastifyInstance, access: PostgresAccessService,
  browserAuth?: BrowserAuthentication, localDevBrowserAccess?: LocalDevBrowserAccess): void {
  app.post<{ Body: unknown }>('/api/auth/enroll', async (request, reply) => {
    requireLocalRequest(request)
    if (browserAuth || localDevBrowserAccess) throw new DomainError('BROWSER_TOKEN_ENROLLMENT_DISABLED', 'Browser token enrollment is disabled. CLI and MCP bearer credentials remain supported.', 403)
    const input = z.object({ token: z.string().trim().min(1) }).strict().parse(request.body)
    const principal = await access.authenticate(input.token, 'operator')
    reply.header('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(input.token)}; HttpOnly; SameSite=Strict; Path=/`)
    return { principal: { id: principal.id, name: principal.name, expiresAt: principal.expiresAt } }
  })

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (!path?.startsWith('/api/') || path === '/api/auth/enroll' || isPublicBrowserAuthRequest(request)) return
    requireLocalRequest(request)
    reply.header('cache-control', 'no-store')
    if (path.startsWith('/api/user/')) {
      const headerToken = bearerToken(request.headers.authorization)
      if (request.headers.authorization !== undefined && !headerToken) {
        throw new DomainError('AUTH_INVALID', 'The Authorization header is invalid.', 401)
      }
      // Explicit User bearer credentials remain isolated and are authenticated
      // by the route. With no header, a verified owner browser session supplies
      // the first-party human identity without minting another secret.
      if (headerToken) return
      if (localDevBrowserAccess) {
        localDevBrowserAccess.requireLocalBrowser(request, !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        request.operatorPrincipal = await localDevBrowserAccess.authenticate()
        request.operatorAuthentication = 'browser'
        request.operatorLocalDev = true
        return
      }
      if (!browserAuth) return
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) browserAuth.requireMutationOrigin(request)
      request.operatorPrincipal = await browserAuth.authenticate(request, reply)
      request.operatorAuthentication = 'browser'
      return
    }
    // Clearing a stale session must not depend on authenticating that session.
    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (localDevBrowserAccess) throw new DomainError('DEV_BROWSER_ALWAYS_ACTIVE', 'Local development browser access remains active while the dev server runs.', 409)
      browserAuth?.requireMutationOrigin(request)
      if (!request.headers.origin) {
        throw new DomainError('CSRF_ORIGIN_REQUIRED', 'Logout requires a trusted Origin header.', 403)
      }
      return
    }
    const headerToken = bearerToken(request.headers.authorization)
    if (request.headers.authorization !== undefined && !headerToken) {
      throw new DomainError('AUTH_INVALID', 'The Authorization header is invalid.', 401)
    }
    const browserToken = headerToken || browserAuth || localDevBrowserAccess ? undefined : cookieToken(request.headers.cookie)
    if (!headerToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (localDevBrowserAccess) localDevBrowserAccess.requireLocalBrowser(request, true)
      else if (browserAuth) browserAuth.requireMutationOrigin(request)
      else if (browserToken && !request.headers.origin) {
        throw new DomainError('CSRF_ORIGIN_REQUIRED', 'Browser mutations require a trusted Origin header.', 403)
      }
    }
    // Explicit bearer credentials always win; invalid credentials never fall back to a cookie.
    const authenticate = () => headerToken ? access.authenticate(headerToken, 'operator')
      : localDevBrowserAccess ? localDevBrowserAccess.authenticate()
      : browserAuth ? browserAuth.authenticate(request, reply)
      : access.authenticate(browserToken, 'operator')
    if (!headerToken && localDevBrowserAccess) localDevBrowserAccess.requireLocalBrowser(request, false)
    const principal = await authenticate()
    request.operatorPrincipal = principal
    request.operatorAuthentication = headerToken ? 'bearer' : 'browser'
    if (!headerToken && localDevBrowserAccess) request.operatorLocalDev = true
    // Agent-chat resources live in the validated query/body or persisted conversation,
    // not these workspace-only route params. The shared chat service checks the full
    // resource before reads/mutations; SSE repeats that check after authenticating.
    const agentChat = /^\/api\/workspaces\/[^/]+\/agent-chat(?:\/|$)/.test(path)
    const params = request.params as Record<string, string | undefined>
    const resource = {
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    }
    request.reauthorizeOperator = async () => {
      const current = await authenticate()
      // Re-check against the same route resource; scoped grants never match an empty resource.
      if (!agentChat) requireAuthorization(current, actionFor(request), resource)
      return current
    }
    if (!agentChat && !request.url.startsWith('/api/management/') && !request.url.startsWith('/api/auth/')) {
      requireAuthorization(principal, actionFor(request), resource)
      if (request.method === 'GET' && /^\/api\/workspaces\/[^/]+\/runs\/[^/]+(?:\?.*)?$/.test(request.url)) {
        requireAuthorization(principal, 'workspace_locations:read', resource)
      }
      if (request.method === 'GET' && /^\/api\/workspaces\/[^/]+(?:\?.*)?$/.test(request.url)) {
        for (const action of ['workflows:read', 'agents:read', 'runs:read'] as const) {
          requireAuthorization(principal, action, resource)
        }
      }
    }
  })

  app.get('/api/auth/session', async (request, reply) => {
    const principal = requirePrincipal(request)
    reply.header('cache-control', 'no-store')
    reply.header('vary', 'Cookie, Authorization')
    return BrowserAccessSessionSchema.parse({ ...(request.browserAccount ? { account: request.browserAccount } : {}),
      ...(request.operatorLocalDev ? { localDev: true } : {}), principal: {
      id: principal.id, name: principal.name, expiresAt: principal.expiresAt, grants: principal.grants,
    } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    if (browserAuth) await browserAuth.signOut(request, reply)
    appendAuthCookies(reply, [`${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`])
    reply.header('cache-control', 'no-store')
    return { signedOut: true }
  })
}
