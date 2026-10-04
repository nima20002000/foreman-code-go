import { createHash, randomUUID } from 'node:crypto'

import {
  DEFAULT_MANAGEMENT_ACTIONS, OwnerSetupRequestSchema,
  type ManagementPrincipal, type OwnerSetupStatus,
} from '@foreman-code/contracts/management'
import { betterAuth } from 'better-auth'
import { hashPassword } from 'better-auth/crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'

import type { PostgresAccessService } from '../access/postgres.js'
import { DomainError } from '../errors.js'
import type { BrowserAuthConfig } from './config.js'

const DAY = 86_400
const SessionReadbackSchema = z.object({
  user: z.object({ id: z.string().min(1), name: z.string().min(1), email: z.string().email() }),
  session: z.object({ id: z.string().min(1), expiresAt: z.string().datetime() }),
}).nullable()

function digest(value: string): Buffer { return createHash('sha256').update(value).digest() }

/** Set-Cookie cannot be comma-joined; it may contain an Expires date. */
export function appendAuthCookies(reply: FastifyReply, cookies: string[]): void {
  if (!cookies.length || reply.sent || reply.raw.headersSent) return
  const previous = reply.getHeader('set-cookie')
  const existing = Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : []
  reply.header('set-cookie', [...existing, ...cookies])
}

function createAuth(pool: pg.Pool, config: BrowserAuthConfig) {
  return betterAuth({
    appName: 'GraphQL',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
    // Session reads are internal authorization checks, not a public auth endpoint.
    rateLimit: { enabled: true, customRules: { '/get-session': false, '/sign-in/email': { window: 60, max: 10 } } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: { modelName: 'browser_auth_user' },
    account: { modelName: 'browser_auth_account' },
    verification: { modelName: 'browser_auth_verification' },
    session: {
      modelName: 'browser_auth_session',
      expiresIn: 7 * DAY,
      updateAge: DAY,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: 'graphql-owner',
      useSecureCookies: config.origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-graphql-client-ip'] },
    },
  })
}

export class BrowserAuthentication {
  private auth?: ReturnType<typeof createAuth>

  constructor(
    private readonly pool: pg.Pool,
    private readonly access: PostgresAccessService,
    private readonly config: BrowserAuthConfig,
  ) {}

  private getAuth(): ReturnType<typeof createAuth> {
    return this.auth ??= createAuth(this.pool, this.config)
  }

  requireMutationOrigin(request: FastifyRequest): void {
    // Compare the full configured origin, not merely "some localhost port".
    if (request.headers.origin !== this.config.origin) {
      throw new DomainError('CSRF_ORIGIN_NOT_ALLOWED', 'This action requires the configured browser Origin.', 403)
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new DomainError('CSRF_ORIGIN_NOT_ALLOWED', 'Cross-site browser actions are not allowed.', 403)
    }
  }

  async setupStatus(): Promise<OwnerSetupStatus> {
    const state = await this.pool.query<{ owner: boolean; users: boolean; credentials: boolean }>(`
      select exists(select 1 from browser_auth_owner) as owner,
             exists(select 1 from browser_auth_user) as users,
             exists(select 1 from management_principals) as credentials
    `)
    const row = state.rows[0]!
    if (row.owner) return { state: 'complete' }
    if (row.users) return { state: 'locked', reason: 'inconsistent-owner' }
    if (row.credentials && !this.config.ownerPrincipalId) return { state: 'locked', reason: 'existing-installation' }
    return { state: 'ready' }
  }

  /** Atomic, restart-safe limit shared by every process using the database. */
  async limitAttempt(kind: 'setup' | 'sign-in', request: FastifyRequest): Promise<void> {
    const seconds = kind === 'setup' ? 600 : 60
    const maximum = kind === 'setup' ? 5 : 10
    const key = digest(`${kind}:${request.ip}`).toString('hex')
    await this.pool.query('delete from browser_auth_attempts where expires_at < now()')
    const result = await this.pool.query<{ attempts: number }>(`
      insert into browser_auth_attempts (key, attempts, expires_at)
      values ($1, 1, now() + $2 * interval '1 second')
      on conflict (key) do update set
        attempts = case when browser_auth_attempts.expires_at <= now() then 1 else browser_auth_attempts.attempts + 1 end,
        expires_at = case when browser_auth_attempts.expires_at <= now() then excluded.expires_at else browser_auth_attempts.expires_at end
      returning attempts
    `, [key, seconds])
    if (result.rows[0]!.attempts > maximum) {
      throw new DomainError('AUTH_RATE_LIMITED', 'Too many attempts. Try again later.', 429)
    }
  }

  async createOwner(value: unknown): Promise<void> {
    const input = OwnerSetupRequestSchema.parse(value)
    // Hash before taking database locks. This is Better Auth's own password format.
    const password = await hashPassword(input.password)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock($1)', [810_018])
      const occupied = await client.query(`select 1 from browser_auth_owner union all select 1 from browser_auth_user limit 1`)
      if (occupied.rowCount) throw new DomainError('OWNER_ALREADY_CONFIGURED', 'Owner registration is already closed.', 409)
      // Also serialize against CLI credential creation while deciding whether this is a fresh installation.
      await client.query('lock table management_principals in share row exclusive mode')
      let principalId = this.config.ownerPrincipalId
      if (principalId) {
        const candidate = await client.query<{ id: string }>(`
          select id from management_principals
          where id = $1 and audience = 'operator' and delegated_from is null
            and revoked_at is null and expires_at > now()
          for update
        `, [principalId])
        if (!candidate.rowCount) throw new DomainError('OWNER_PRINCIPAL_INVALID', 'The server-selected owner principal must be an active, non-delegated Operator.', 409)
        // Never widen grants, renew an expired credential, or silently choose another principal.
      } else {
        const existing = await client.query('select 1 from management_principals limit 1')
        if (existing.rowCount) throw new DomainError('OWNER_PRINCIPAL_REQUIRED', 'This installation already has credentials. Select its owner principal in the server configuration.', 409)
        const issued = await this.access.issue({
          name: input.email,
          audience: 'operator',
          grants: [{ actions: [...DEFAULT_MANAGEMENT_ACTIONS], scope: {} }],
          expiresAt: new Date(Date.now() + 3650 * DAY * 1000),
        }, client)
        principalId = issued.principal.id
        // This principal is a durable authority record; its generated bearer secret is never exposed or stored.
      }
      const userId = randomUUID()
      // Better Auth requires a name; reuse the email until profiles are editable.
      await client.query(`insert into browser_auth_user (id, name, email) values ($1, $2, $3)`,
        [userId, input.email, input.email])
      await client.query(`insert into browser_auth_account (id, "userId", "accountId", "providerId", password)
        values ($1, $2, $2, 'credential', $3)`, [randomUUID(), userId, password])
      await client.query('insert into browser_auth_owner (singleton, user_id, principal_id) values (true, $1, $2)',
        [userId, principalId])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  }

  /** Only our explicitly registered routes can reach Better Auth's handler. */
  private async call(path: string, request: FastifyRequest, body?: unknown): Promise<Response> {
    const headers = new Headers({ accept: 'application/json', 'x-graphql-client-ip': request.ip })
    // Do not forward Authorization or proxy/IP headers supplied by the caller.
    for (const key of ['cookie', 'origin', 'user-agent', 'sec-fetch-site'] as const) {
      const value = request.headers[key]
      if (typeof value === 'string') headers.set(key, value)
    }
    if (body !== undefined) headers.set('content-type', 'application/json')
    try {
      return await this.getAuth().handler(new Request(new URL(`/api/auth/${path}`, this.config.origin), {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }))
    } catch {
      throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'The authentication service could not complete the request.', 503)
    }
  }

  private requireSuccess(response: Response): void {
    if (response.ok) return
    if (response.status >= 500) throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'The authentication service is unavailable. Try again.', 503)
    if (response.status === 429) throw new DomainError('AUTH_RATE_LIMITED', 'Too many attempts. Try again later.', 429)
    if (response.status === 403) throw new DomainError('AUTH_FORBIDDEN', 'The authentication request is not allowed.', 403)
    if (response.status === 400 || response.status === 401) throw new DomainError('AUTH_INVALID', 'The email or password is incorrect, or the session has expired.', 401)
    throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'The authentication service returned an unexpected response.', 503)
  }

  async signIn(request: FastifyRequest, reply: FastifyReply, input: { email: string; password: string }): Promise<void> {
    const response = await this.call('sign-in/email', request, { ...input, rememberMe: true })
    this.requireSuccess(response)
    appendAuthCookies(reply, response.headers.getSetCookie())
    // In particular, never relay Better Auth's token field to browser JavaScript.
  }

  async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<ManagementPrincipal> {
    const response = await this.call('get-session?disableCookieCache=true', request)
    this.requireSuccess(response)
    const parsed = SessionReadbackSchema.safeParse(await response.json())
    if (!parsed.success) throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'The authentication service returned an invalid session.', 503)
    appendAuthCookies(reply, response.headers.getSetCookie())
    if (!parsed.data) throw new DomainError('AUTH_REQUIRED', 'Sign in to continue.', 401)
    request.browserAccount = { name: parsed.data.user.name, email: parsed.data.user.email }
    const expiry = Date.parse(parsed.data.session.expiresAt)
    if (expiry <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'Your session expired. Sign in again.', 401)
    const owner = await this.pool.query<{ principal_id: string }>('select principal_id from browser_auth_owner where user_id = $1', [parsed.data.user.id])
    if (!owner.rows[0]) throw new DomainError('ACCESS_DENIED', 'This account has no Operator authority.', 403)
    try {
      const principal = await this.access.currentOperator(owner.rows[0].principal_id)
      return { ...principal, expiresAt: new Date(Math.min(expiry, Date.parse(principal.expiresAt))).toISOString() }
    } catch (error) {
      // A valid login with withdrawn authority is forbidden, not a password/login failure.
      if (error instanceof DomainError && (error.status === 401 || error.status === 403)) {
        throw new DomainError('ACCESS_DENIED', 'Operator access for this account has expired or been revoked.', 403)
      }
      throw error
    }
  }

  async signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Better Auth's sign-out intentionally catches database-delete errors. Verify the
    // signed session through Better Auth, then require our own durable delete to
    // succeed before clearing cookies or reporting signedOut:true.
    const current = await this.call('get-session?disableCookieCache=true', request)
    this.requireSuccess(current)
    const parsed = SessionReadbackSchema.safeParse(await current.json())
    if (!parsed.success) throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'The session could not be checked before sign-out.', 503)
    if (parsed.data) {
      try { await this.pool.query('delete from browser_auth_session where id = $1', [parsed.data.session.id]) }
      catch { throw new DomainError('AUTH_BACKEND_UNAVAILABLE', 'Sign-out was not confirmed. Retry when the database is available.', 503) }
    }
    const response = await this.call('sign-out', request, {})
    this.requireSuccess(response)
    appendAuthCookies(reply, response.headers.getSetCookie())
  }
}
