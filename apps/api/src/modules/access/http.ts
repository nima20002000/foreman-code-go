import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { BrowserAccessSessionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { hasAction, requireAuthorization } from './policy.js'
import { bearerToken, type PostgresAccessService } from './postgres.js'
import { DomainError } from '../errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    operatorPrincipal?: ManagementPrincipal
    reauthorizeOperator?: () => Promise<ManagementPrincipal>
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
  if (url === '/api/interactions' || url.startsWith('/api/interactions/')) {
    return request.method === 'GET' || request.method === 'HEAD' ? 'interactions:read' as const : 'interactions:respond' as const
  }
  if (url.startsWith('/api/operator/conversations')) {
    if (['GET', 'HEAD'].includes(request.method)) return 'operator_chat:read' as const
    if (url.endsWith('/cancel')) return 'operator_chat:cancel' as const
    if (url.endsWith('/responses')) return 'operator_chat:respond' as const
    return 'operator_chat:write' as const
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

export function registerOperatorHttpSecurity(app: FastifyInstance, access: PostgresAccessService): void {
  app.post<{ Body: unknown }>('/api/auth/enroll', async (request, reply) => {
    requireLocalRequest(request)
    const input = z.object({ token: z.string().trim().min(1) }).strict().parse(request.body)
    const principal = await access.authenticate(input.token, 'operator')
    reply.header('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(input.token)}; HttpOnly; SameSite=Strict; Path=/`)
    return { principal: { id: principal.id, name: principal.name, expiresAt: principal.expiresAt } }
  })

  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0]
    if (!path?.startsWith('/api/') || path === '/api/auth/enroll' || path.startsWith('/api/user/')) return
    requireLocalRequest(request)
    // Clearing a stale session must not depend on authenticating that session.
    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (!request.headers.origin) {
        throw new DomainError('CSRF_ORIGIN_REQUIRED', 'Logout requires a trusted Origin header.', 403)
      }
      return
    }
    const headerToken = bearerToken(request.headers.authorization)
    const browserToken = headerToken ? undefined : cookieToken(request.headers.cookie)
    if (!headerToken && browserToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.headers.origin) {
      throw new DomainError('CSRF_ORIGIN_REQUIRED', 'Browser mutations require a trusted Origin header.', 403)
    }
    const token = headerToken ?? browserToken
    const principal = await access.authenticate(token, 'operator')
    request.operatorPrincipal = principal
    request.reauthorizeOperator = async () => {
      const current = await access.authenticate(token, 'operator')
      requireAuthorization(current, actionFor(request))
      return current
    }
    if (path === '/api/interactions' || path.startsWith('/api/interactions/')) {
      // The route resolves the durable interaction (or validated list filters)
      // before authorizing its workspace/workflow/run. An ID is not a scope.
      if (!hasAction(principal, actionFor(request))) {
        throw new DomainError('ACCESS_DENIED', 'The caller is not authorized for this interaction operation.', 403)
      }
      return
    }
    if (!request.url.startsWith('/api/management/') && !request.url.startsWith('/api/auth/')) {
      const params = request.params as Record<string, string | undefined>
      const resource = {
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
      }
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
    return BrowserAccessSessionSchema.parse({ principal: {
      id: principal.id, name: principal.name, expiresAt: principal.expiresAt, grants: principal.grants,
    } })
  })

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.header('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    return { signedOut: true }
  })
}
