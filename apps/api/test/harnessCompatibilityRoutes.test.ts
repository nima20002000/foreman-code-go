import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { HarnessCompatibilityService } from '../src/modules/harnesses/compatibility/service.js'
import { registerHarnessCompatibilityRoutes } from '../src/routes/harnessCompatibility.js'

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
function principal(update = true): ManagementPrincipal {
  return ManagementPrincipalSchema.parse({ id: 'owner', name: 'Owner', audience: 'operator',
    grants: [{ actions: update ? ['harnesses:read', 'harnesses:update'] : ['harnesses:read'], scope: {} }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null })
}
function fixture(identity = principal()) {
  const app = Fastify(); apps.push(app)
  const inspect = vi.fn(async (harness: 'codex' | 'opencode') => ({ executable: '/fake/cli', identity: harness, version: '99.0.0' }))
  const service = new HarnessCompatibilityService({
    probe: { inspect, probe: async () => 'f'.repeat(64), assertUnchanged: async () => undefined },
    cache: { load: async () => null, save: async () => undefined },
  })
  const access = { authenticate: async (token: string | undefined) => {
    if (token !== 'owner-token') throw new DomainError('AUTH_REQUIRED', 'Sign in.', 401)
    return identity
  } } as unknown as PostgresAccessService
  registerOperatorHttpSecurity(app, access)
  registerHarnessCompatibilityRoutes(app, service)
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500
    void reply.code(status).send({ error: { code: 'TEST_ERROR', message: 'Request rejected.' } })
  })
  app.addHook('onClose', () => service.close())
  return { app, inspect, service }
}
const readUrl = '/api/management/harnesses/compatibility'
const retryUrl = '/api/management/harnesses/codex/compatibility/retry'
const authorized = { authorization: 'Bearer owner-token' }
describe('compatibility route authorization and request boundaries', () => {
  it('requires authentication and never starts a process on a status read', async () => {
    const { app, inspect } = fixture()
    expect((await app.inject({ method: 'GET', url: readUrl })).statusCode).toBe(401)
    const response = await app.inject({ method: 'GET', url: readUrl, headers: authorized })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().harnesses).toHaveLength(2)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('shows read-only status without granting retry permission', async () => {
    const { app, inspect } = fixture(principal(false))
    const response = await app.inject({ method: 'GET', url: readUrl, headers: authorized })
    expect(response.json().canRetry).toBe(false)
    expect((await app.inject({ method: 'POST', url: retryUrl, headers: authorized, payload: {} })).statusCode).toBe(403)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('accepts an authorized retry without waiting for a CLI check', async () => {
    const { app } = fixture()
    const response = await app.inject({ method: 'POST', url: retryUrl, headers: authorized, payload: {} })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ harness: 'codex', status: 'checking', scope: 'protocol-settings-diagnostic-only' })
  })
  it('rejects caller-selected binaries and invalid harnesses before starting work', async () => {
    const { app, inspect } = fixture()
    expect((await app.inject({ method: 'POST', url: retryUrl, headers: authorized, payload: { binary: '/arbitrary' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: retryUrl.replace('/codex/', '/other/'), headers: authorized, payload: {} })).statusCode).toBe(400)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('keeps the existing browser mutation Origin boundary', async () => {
    const { app, inspect } = fixture()
    expect((await app.inject({ method: 'POST', url: retryUrl, headers: { cookie: 'graphql_operator=owner-token' }, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: retryUrl, headers: { ...authorized, origin: 'https://attacker.invalid' }, payload: {} })).statusCode).toBe(403)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('does not treat scoped or worker grants as global harness authority', async () => {
    const scoped = principal()
    scoped.grants[0]!.scope = { workspaceIds: ['workspace-one'] }
    const { app } = fixture(scoped)
    expect((await app.inject({ method: 'GET', url: readUrl, headers: authorized })).statusCode).toBe(403)
    const worker = fixture({ ...principal(), audience: 'worker', agentId: 'agent-one' })
    expect((await worker.app.inject({ method: 'POST', url: retryUrl, headers: authorized, payload: {} })).statusCode).toBe(403)
  })
})
