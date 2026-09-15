import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  ManagementGrantSchema,
  ManagementPrincipalSchema,
  type ManagementAudience,
  type ManagementGrant,
  type ManagementPrincipal,
} from '@graphql/contracts/management'
import type pg from 'pg'

import { DomainError } from '../errors.js'

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface PrincipalRow {
  id: string
  name: string
  audience: ManagementAudience
  token_hash: string
  grants: unknown
  expires_at: Date
  revoked_at: Date | null
}

function fromRow(row: PrincipalRow): ManagementPrincipal {
  return ManagementPrincipalSchema.parse({
    id: row.id,
    name: row.name,
    audience: row.audience,
    grants: row.grants,
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  })
}

export class PostgresAccessService {
  constructor(private readonly pool: pg.Pool) {}

  async authenticate(token: string | undefined, audience: ManagementAudience = 'operator'): Promise<ManagementPrincipal> {
    if (!token) throw new DomainError('AUTH_REQUIRED', 'A bearer credential is required.', 401)
    const tokenHash = digest(token)
    const result = await this.pool.query<PrincipalRow>(
      `select id, name, audience, token_hash, grants, expires_at, revoked_at
       from management_principals where token_hash = $1`,
      [tokenHash],
    )
    const row = result.rows[0]
    if (!row || !sameDigest(row.token_hash, tokenHash)) {
      throw new DomainError('AUTH_INVALID', 'The supplied credential is invalid.', 401)
    }
    if (row.audience !== audience) throw new DomainError('AUTH_WRONG_AUDIENCE', 'The credential cannot access this endpoint.', 403)
    if (row.revoked_at) throw new DomainError('AUTH_REVOKED', 'The credential has been revoked.', 401)
    if (row.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'The credential has expired.', 401)
    return fromRow(row)
  }

  async issue(input: {
    name: string
    audience: ManagementAudience
    grants: ManagementGrant[]
    expiresAt: Date
  }): Promise<{ principal: ManagementPrincipal; token: string }> {
    if (input.expiresAt.getTime() <= Date.now()) throw new DomainError('INVALID_EXPIRY', 'Credential expiry must be in the future.', 400)
    const name = input.name.trim()
    if (!name) throw new DomainError('INVALID_PRINCIPAL_NAME', 'Credential name is required.', 400)
    const grants = input.grants.map((grant) => ManagementGrantSchema.parse(grant))
    const id = `principal-${randomUUID()}`
    const token = `opm_${randomBytes(32).toString('base64url')}`
    const result = await this.pool.query<PrincipalRow>(
      `insert into management_principals (id, name, audience, token_hash, grants, expires_at)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       returning id, name, audience, token_hash, grants, expires_at, revoked_at`,
      [id, name, input.audience, digest(token), JSON.stringify(grants), input.expiresAt],
    )
    return { principal: fromRow(result.rows[0]!), token }
  }

  async revoke(principalId: string): Promise<boolean> {
    const result = await this.pool.query(
      'update management_principals set revoked_at = coalesce(revoked_at, now()) where id = $1',
      [principalId],
    )
    return result.rowCount === 1
  }
}

export function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? '')
  return match?.[1]
}
