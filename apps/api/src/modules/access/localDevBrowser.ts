import { resolveLocalBrowserOrigin } from '@graphql/contracts/browser-origin'
import { randomBytes } from 'node:crypto'

import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import type { FastifyRequest } from 'fastify'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import type { PostgresAccessService } from './postgres.js'

const DEV_PRINCIPAL_ID = 'principal-local-development-browser'
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Local dev uses a persisted Operator, so every ordinary grant and scope check still applies. */
export class LocalDevBrowserAccess {
  private resolvedPrincipalId?: string

  constructor(private readonly pool: pg.Pool, private readonly access: PostgresAccessService,
    private readonly selectedPrincipalId?: string,
    private readonly browserOrigin = resolveLocalBrowserOrigin({}).origin) {}

  requireLocalBrowser(request: FastifyRequest, mutation: boolean): void {
    if (!LOOPBACK_IPS.has(request.ip)) throw new DomainError('DEV_BROWSER_LOCAL_REQUIRED', 'Local development browser access requires a loopback client.', 403)
    if (request.headers.origin && request.headers.origin !== this.browserOrigin) {
      throw new DomainError('CSRF_ORIGIN_NOT_ALLOWED', 'This action requires the local development browser Origin.', 403)
    }
    if (mutation && request.headers.origin !== this.browserOrigin) {
      throw new DomainError('CSRF_ORIGIN_REQUIRED', 'Browser mutations require the local development browser Origin.', 403)
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new DomainError('CSRF_ORIGIN_NOT_ALLOWED', 'Cross-site browser actions are not allowed.', 403)
    }
  }

  async authenticate(): Promise<ManagementPrincipal> {
    const client = await this.pool.connect()
    let principalId: string
    try {
      await client.query('begin')
      // Owner setup takes the same lock; neither path can race past the installation decision.
      await client.query('select pg_advisory_xact_lock($1)', [810_018])
      const owner = await client.query<{ principal_id: string }>('select principal_id from browser_auth_owner where singleton = true')
      principalId = this.selectedPrincipalId ?? this.resolvedPrincipalId ?? owner.rows[0]?.principal_id ?? DEV_PRINCIPAL_ID
      if (!this.selectedPrincipalId && !this.resolvedPrincipalId && !owner.rowCount) {
        await client.query('lock table management_principals in share row exclusive mode')
        const existingDev = await client.query('select 1 from management_principals where id=$1', [DEV_PRINCIPAL_ID])
        if (!existingDev.rowCount) {
          const eligible = await client.query<{ id: string }>(`select id from management_principals
            where audience='operator' and delegated_from is null and revoked_at is null and expires_at > now()
            limit 2`)
          if (eligible.rowCount === 1) {
            principalId = eligible.rows[0]!.id
          } else if ((await client.query('select 1 from management_principals limit 1')).rowCount) {
            throw new DomainError('DEV_BROWSER_PRINCIPAL_REQUIRED',
              'Select an existing root Operator with GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID for this local database.', 503)
          } else {
            await client.query(`insert into management_principals
              (id,name,audience,token_hash,grants,expires_at)
              values($1,$2,'operator',$3,$4::jsonb,$5)`, [
              DEV_PRINCIPAL_ID, 'Local development browser', randomBytes(32).toString('hex'),
              JSON.stringify([{ actions: [...ManagementActionSchema.options], scope: {} }]),
              new Date(Date.now() + 3650 * 86_400_000),
            ])
          }
        }
      }
      const root = await client.query('select 1 from management_principals where id=$1 and audience=$2 and delegated_from is null',
        [principalId, 'operator'])
      if (!root.rowCount) throw new DomainError('DEV_BROWSER_PRINCIPAL_INVALID', 'Local development browser access requires an existing root Operator.', 403)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
    this.resolvedPrincipalId = principalId
    try { return await this.access.currentOperator(principalId) }
    catch (error) {
      if (error instanceof DomainError && (error.status === 401 || error.status === 403)) {
        throw new DomainError('ACCESS_DENIED', 'The selected local development Operator is no longer active.', 403)
      }
      throw error
    }
  }
}
