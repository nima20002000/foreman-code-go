import Fastify, { type FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema } from '@graphql/contracts/management'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { BrowserAuthentication } from '../src/modules/browser-auth/service.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { registerHarnessSettingsRoutes } from '../src/routes/harnessSettings.js'

describe.each(['current', 'legacy'] as const)('%s browser-only route authentication', (mode) => {
  it('accepts verified browsers for browsing and decisions, rejects bearer and forged cookies, and preserves CSRF checks', async () => {
    const app = Fastify()
    const principal = ManagementPrincipalSchema.parse({
      id: 'owner', name: 'Owner', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'workspace_locations:read'], scope: {} }],
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    })
    const browse = vi.fn(async () => ({ roots: [], rootId: null, path: null, parent: null, directories: [], nextCursor: null }))
    const planId = '00000000-0000-4000-8000-000000000001'
    const decide = vi.fn(async () => ({
      id: planId, harness: 'codex', revision: 'sha256:' + 'a'.repeat(64),
      change: { kind: 'remove', name: 'example' }, requestedBy: 'owner', status: 'rejected',
      createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', error: null,
    }))
    registerOperatorHttpSecurity(app, {
      authenticate: async (token: string | undefined) => {
        if (token !== 'owner-token') throw new DomainError('AUTH_REQUIRED', 'Sign in.', 401)
        return principal
      },
    } as unknown as PostgresAccessService, mode === 'current' ? {
      authenticate: async (request: FastifyRequest) => {
        if (request.headers.cookie !== 'session=verified') throw new DomainError('AUTH_REQUIRED', 'Sign in.', 401)
        return principal
      },
      requireMutationOrigin: (request: FastifyRequest) => {
        if (request.headers.origin !== 'http://localhost:5173') throw new DomainError('CSRF_ORIGIN_NOT_ALLOWED', 'Invalid origin.', 403)
      },
    } as unknown as BrowserAuthentication : undefined)
    registerHarnessSettingsRoutes(app, { harnessSettings: { directories: { browse }, mcp: { decide } } } as unknown as OperatorServices)
    app.setErrorHandler((error, _request, reply) => {
      void reply.code(error instanceof DomainError ? error.status : 500).send({})
    })
    try {
      const cookie = mode === 'current' ? 'session=verified' : 'graphql_operator=owner-token'
      const origin = 'http://localhost:5173'
      const url = '/api/management/harnesses/directories'
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(200)
      for (const headers of [
        { authorization: 'Bearer owner-token' },
        { authorization: 'Bearer owner-token', cookie },
      ]) {
        expect((await app.inject({ url, headers })).statusCode).toBe(403)
      }
      for (const headers of [{}, { cookie: 'graphql_operator=forged' }, { cookie, authorization: 'Bearer invalid' }, { cookie, authorization: 'invalid' }]) {
        expect((await app.inject({ url, headers })).statusCode).toBe(401)
      }
      expect(browse).toHaveBeenCalledOnce()
      const decision = { method: 'POST' as const, url: '/api/management/harnesses/mcp/decision', payload: { planId, approve: false } }
      expect((await app.inject({ ...decision, headers: { cookie, origin } })).statusCode).toBe(200)
      for (const headers of [
        { cookie }, { cookie, origin: 'https://attacker.invalid' },
        { cookie, origin, authorization: 'Bearer owner-token' },
      ]) {
        expect((await app.inject({ ...decision, headers })).statusCode).toBe(403)
      }
      if (mode === 'current') {
        expect((await app.inject({ ...decision, headers: { cookie, origin: 'http://localhost:9999' } })).statusCode).toBe(403)
      }
      expect(decide).toHaveBeenCalledOnce()
    } finally { await app.close() }
  })
})
