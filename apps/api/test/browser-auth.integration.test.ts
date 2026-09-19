import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import pg from 'pg'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { ManagementActionSchema, ManagedWorkspaceDefaultsSchema } from '@graphql/contracts/management'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { BrowserAuthentication } from '../src/modules/browser-auth/service.js'
import { registerBrowserAuthRoutes } from '../src/modules/browser-auth/routes.js'
import type { BrowserAuthConfig } from '../src/modules/browser-auth/config.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { registerWorkspaceDefaultsRoutes } from '../src/routes/workspaceDefaults.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const config: BrowserAuthConfig = {
  origin: 'http://localhost:5173', secret: 'browser-test-session-secret-'.repeat(3),
}
const owner = { email: 'owner@example.test', password: 'a-long-owner-test-password' }
const headers = { host: 'localhost:3000', origin: config.origin }
function cookies(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value : value ? [value] : []).map((part) => part.split(';')[0]).join('; ')
}

type Fixture = { pool: pg.Pool; access: PostgresAccessService; coldAuth: BrowserAuthentication;
  app: (overrides?: Partial<BrowserAuthConfig>, existingAuth?: BrowserAuthentication) => FastifyInstance }
async function withDatabase(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const schema = `browser_auth_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  const apps: FastifyInstance[] = []
  let pool: pg.Pool | undefined
  try {
    await admin.query(`create schema "${schema}"`)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 })
    const database = pool
    const access = new PostgresAccessService(database)
    const coldAuth = new BrowserAuthentication(database, access, config)
    await applyApplicationMigrations(pool)
    await applyApplicationMigrations(pool)
    const settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(database), new PostgresCommandCoordinator(database))
    const app = (overrides: Partial<BrowserAuthConfig> = {}, existingAuth?: BrowserAuthentication) => {
      const server = Fastify()
      const auth = existingAuth ?? new BrowserAuthentication(database, access, { ...config, ...overrides })
      registerBrowserAuthRoutes(server, auth)
      registerOperatorHttpSecurity(server, access, auth)
      // Real production route and settings/command repositories; unrelated harnesses are not started.
      registerWorkspaceDefaultsRoutes(server, { settings } as OperatorServices)
      server.setErrorHandler((error, _request, reply) => {
        const status = error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500
        return reply.code(status).send({ error: { code: error instanceof DomainError ? error.code : 'TEST_BACKEND_ERROR', message: 'Request failed.' } })
      })
      apps.push(server)
      return server
    }
    await work({ pool: database, access, coldAuth, app })
  } finally {
    await Promise.all(apps.map((app) => app.close()))
    await pool?.end()
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.end()
  }
}
async function setup(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: owner })
  expect(response.statusCode).toBe(201)
  expect(response.json()).toEqual({ created: true })
}
async function signIn(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: owner.email, password: owner.password } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ signedIn: true })
  return response
}

describe('Better Auth owner browser lifecycle (PostgreSQL)', () => {
  it('initializes the auth engine after cold-start migrations', async () => withDatabase(async ({ app, coldAuth }) => {
    const server = app({}, coldAuth)
    expect((await server.inject({ method: 'GET', url: '/api/auth/session', headers })).statusCode).toBe(401)
  }), 30_000)

  it('accepts email and password once, rejects other origins and public registration', async () => withDatabase(async ({ app, pool }) => {
    const server = app()
    expect((await server.inject({ method: 'GET', url: '/api/auth/setup', headers })).json()).toEqual({ state: 'ready' })
    expect((await server.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...headers, origin: 'http://localhost:9999' }, payload: owner })).statusCode).toBe(403)
    expect((await server.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { ...owner, name: 'Admin' } })).statusCode).toBe(400)
    expect((await server.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers, payload: owner })).statusCode).toBe(403)
    expect((await pool.query('select * from browser_auth_user')).rowCount).toBe(0)
    await setup(server)
    expect((await server.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { ...owner, email: 'second@example.test' } })).statusCode).toBe(409)
    expect((await server.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers, payload: owner })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: '/api/auth/setup', headers })).json()).toEqual({ state: 'complete' })
    expect((await pool.query('select * from browser_auth_user')).rowCount).toBe(1)
    expect((await pool.query('select * from browser_auth_owner')).rowCount).toBe(1)
    expect((await pool.query<{ password: string }>('select password from browser_auth_account')).rows[0]!.password).not.toBe(owner.password)
  }), 30_000)

  it('serializes simultaneous owner setup and rolls back every owner-related write on failure', async () => withDatabase(async ({ app, pool }) => {
    const server = app()
    await pool.query(`create function fail_owner_insert() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$;
      create trigger fail_owner before insert on browser_auth_owner for each row execute function fail_owner_insert();`)
    expect((await server.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: owner })).statusCode).toBe(500)
    for (const table of ['browser_auth_user', 'browser_auth_account', 'browser_auth_owner', 'management_principals']) {
      expect((await pool.query(`select * from ${table}`)).rowCount).toBe(0)
    }
    await pool.query('drop trigger fail_owner on browser_auth_owner')
    const results = await Promise.all([owner, { ...owner, email: 'race@example.test' }].map((payload) => server.inject({ method: 'POST', url: '/api/auth/setup', headers, payload })))
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409])
    expect((await pool.query('select * from browser_auth_owner')).rowCount).toBe(1)
  }), 30_000)

  it('locks an existing installation until a server-selected principal is provided and never widens its grants', async () => withDatabase(async ({ app, access, pool }) => {
    const issued = await access.issue({ name: 'Existing owner', audience: 'operator', grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 3_600_000) })
    const before = await pool.query('select * from management_principals where id=$1', [issued.principal.id])
    const locked = app()
    expect((await locked.inject({ method: 'GET', url: '/api/auth/setup', headers })).json()).toEqual({ state: 'locked', reason: 'existing-installation' })
    expect((await locked.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: owner })).statusCode).toBe(409)
    const server = app({ ownerPrincipalId: issued.principal.id })
    await setup(server)
    const signedIn = await signIn(server)
    const cookie = cookies(signedIn.headers['set-cookie'])
    const session = await server.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })
    expect(session.json().principal.grants).toEqual(issued.principal.grants)
    expect((await pool.query('select * from management_principals where id=$1', [issued.principal.id])).rows).toEqual(before.rows)
    expect((await server.inject({ method: 'GET', url: '/api/management/settings/workspaces', headers: { ...headers, cookie } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'PUT', url: '/api/management/settings/workspaces', headers: { ...headers, cookie }, payload: { commandId: 'browser-denied-write', expectedRevision: 0, value: { suggestedName: 'Denied', description: '' } } })).statusCode).toBe(403)
    expect((await access.authenticate(issued.token)).id).toBe(issued.principal.id)
  }), 30_000)

  it('signs in, restores persistent cookies after app recreation, loads/saves Workspace defaults and revokes only the browser session on sign-out', async () => withDatabase(async ({ app, access, pool }) => {
    const server = app()
    await setup(server)
    const wrong = await server.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: owner.email, password: 'incorrect-password' } })
    expect(wrong.statusCode).toBe(401)
    const signedIn = await signIn(server)
    const cookie = cookies(signedIn.headers['set-cookie'])
    const setCookies = String(signedIn.headers['set-cookie'])
    expect(setCookies).toMatch(/HttpOnly/i)
    expect(setCookies).toMatch(/SameSite=Strict/i)
    expect(setCookies).toMatch(/Max-Age=|Expires=/i)
    expect(signedIn.body).not.toContain('token')
    const restored = app()
    const session = await restored.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json().account).toEqual({ name: owner.email, email: owner.email })
    expect(session.headers['cache-control']).toBe('no-store')
    const read = await restored.inject({ method: 'GET', url: '/api/management/settings/workspaces', headers: { ...headers, cookie } })
    expect(read.statusCode).toBe(200)
    const defaults = ManagedWorkspaceDefaultsSchema.parse(read.json())
    const saved = await restored.inject({ method: 'PUT', url: '/api/management/settings/workspaces', headers: { ...headers, cookie }, payload: {
      commandId: 'browser-owner-defaults-save', expectedRevision: defaults.revision,
      value: { ...defaults.value, suggestedName: 'Browser workspace' },
    } })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().value.value.suggestedName).toBe('Browser workspace')
    const cli = await access.issue({ name: 'CLI remains active', audience: 'operator', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 3_600_000) })
    const logout = await restored.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })
    expect(logout.statusCode).toBe(200)
    expect(logout.json()).toEqual({ signedOut: true })
    const cleared = logout.headers['set-cookie']
    expect(Array.isArray(cleared) && cleared.length >= 2).toBe(true)
    expect(String(cleared)).toContain('graphql_operator=')
    expect((await pool.query('select * from browser_auth_session')).rowCount).toBe(0)
    expect((await restored.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })).statusCode).toBe(401)
    expect((await restored.inject({ method: 'GET', url: '/api/management/settings/workspaces', headers: { ...headers, authorization: `Bearer ${cli.token}` } })).statusCode).toBe(200)
    expect((await access.authenticate(cli.token)).id).toBe(cli.principal.id)
  }), 30_000)

  it('keeps bearer precedence, rechecks live grants/revocation and rejects CSRF on browser mutations', async () => withDatabase(async ({ app, pool, access }) => {
    const server = app()
    await setup(server)
    const cookie = cookies((await signIn(server)).headers['set-cookie'])
    for (const authorization of ['Bearer invalid', 'Basic invalid']) {
      expect((await server.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie, authorization } })).statusCode).toBe(401)
    }
    for (const origin of [undefined, 'http://localhost:7777', 'https://attacker.example']) {
      const requestHeaders = { host: headers.host, cookie, ...(origin ? { origin } : {}) }
      expect((await server.inject({ method: 'POST', url: '/api/auth/logout', headers: requestHeaders })).statusCode).toBe(403)
    }
    expect((await server.inject({ method: 'POST', url: '/api/auth/enroll', headers, payload: { token: 'not-used' } })).statusCode).toBe(403)
    const principalId = (await pool.query<{ principal_id: string }>('select principal_id from browser_auth_owner')).rows[0]!.principal_id
    await pool.query(`update management_principals set grants='[]'::jsonb where id=$1`, [principalId])
    expect((await server.inject({ method: 'GET', url: '/api/management/settings/workspaces', headers: { ...headers, cookie } })).statusCode).toBe(403)
    await access.revoke(principalId)
    expect((await server.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })).statusCode).toBe(403)
    expect((await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })).statusCode).toBe(200)
  }), 30_000)

  it('does not turn backend failures into an invalid-password response and expires sessions durably', async () => withDatabase(async ({ app, pool }) => {
    const server = app()
    await setup(server)
    const cookie = cookies((await signIn(server)).headers['set-cookie'])
    await pool.query('alter table browser_auth_session rename to temporarily_unavailable_sessions')
    try {
      expect((await server.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })).statusCode).toBe(503)
    } finally { await pool.query('alter table temporarily_unavailable_sessions rename to browser_auth_session') }
    await pool.query(`update browser_auth_session set "expiresAt"=now()-interval '1 second'`)
    expect((await server.inject({ method: 'GET', url: '/api/auth/session', headers: { ...headers, cookie } })).statusCode).toBe(401)
  }), 30_000)

  it('applies a persistent setup attempt limit', async () => withDatabase(async ({ app }) => {
    const server = app()
    const second = app()
    // Both application instances share the same PostgreSQL attempt budget.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await second.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { ...owner, email: 'invalid' } })).statusCode).toBe(400)
    }
    expect((await server.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: owner })).statusCode).toBe(429)
  }), 30_000)
  it('does not confirm sign-out or clear the cookie when durable deletion is rejected', async () => withDatabase(async ({ app, pool }) => {
    const server = app()
    await setup(server)
    const cookie = cookies((await signIn(server)).headers['set-cookie'])
    await pool.query(`create function fail_session_delete() returns trigger language plpgsql as $$ begin raise exception 'delete unavailable'; end $$;
      create trigger fail_session_delete before delete on browser_auth_session for each row execute function fail_session_delete();`)
    const failed = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })
    expect(failed.statusCode).toBe(503)
    expect(failed.headers['set-cookie']).toBeUndefined()
    expect((await pool.query('select * from browser_auth_session')).rowCount).toBe(1)
    await pool.query('drop trigger fail_session_delete on browser_auth_session')
    expect((await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })).statusCode).toBe(200)
    expect((await pool.query('select * from browser_auth_session')).rowCount).toBe(0)
  }), 30_000)

})
