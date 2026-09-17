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
import { requireActiveWorkerBinding } from './workerLifecycle.js'
import { intersectGrants } from './operatorDelegation.js'
import { currentOperatorAuthority } from './runAuthority.js'

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
  agent_id: string | null
  token_hash: string
  grants: unknown
  expires_at: Date
  revoked_at: Date | null
  delegated_from?: string | null
}

function fromRow(row: PrincipalRow): ManagementPrincipal {
  // Migration 100 intentionally cannot infer Agent subjects for old credentials.
  // Deny them explicitly; an operator must issue a replacement with a real subject.
  if (row.audience === 'worker' && !row.agent_id?.trim()) {
    throw new DomainError('AUTH_WORKER_SUBJECT_REQUIRED', 'This legacy worker credential has no Agent subject. Reissue it for the actual Agent.', 401)
  }
  return ManagementPrincipalSchema.parse({
    id: row.id,
    name: row.name,
    audience: row.audience,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
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
      `select id, name, audience, agent_id, token_hash, grants, expires_at, revoked_at, delegated_from
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
    const principal = fromRow(row)
    if (audience === 'worker') await requireActiveWorkerBinding(this.pool, row.id)
    if (row.delegated_from) {
      const parent = await this.currentOperator(row.delegated_from)
      principal.grants = intersectGrants(principal.grants, parent.grants)
      principal.expiresAt = new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(parent.expiresAt))).toISOString()
    }
    return principal
  }

  async currentOperator(id: string): Promise<ManagementPrincipal> {
    return (await currentOperatorAuthority(this.pool, id)).principal
  }

  async issue(input: {
    name: string
    audience: ManagementAudience
    /** Backend-derived for worker credentials; never accepted from an MCP request. */
    agentId?: string
    grants: ManagementGrant[]
    expiresAt: Date
  }, client?: pg.ClientBase): Promise<{ principal: ManagementPrincipal; token: string }> {
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) throw new DomainError('INVALID_EXPIRY', 'Credential expiry must be in the future.', 400)
    const name = input.name.trim()
    if (!name) throw new DomainError('INVALID_PRINCIPAL_NAME', 'Credential name is required.', 400)
    const grants = input.grants.map((grant) => ManagementGrantSchema.parse(grant))
    if (input.audience === 'worker' && !input.agentId?.trim()) {
      throw new DomainError('WORKER_AGENT_REQUIRED', 'Worker credentials require a backend-issued Agent subject.', 400)
    }
    if (input.audience !== 'worker' && input.agentId) {
      throw new DomainError('OPERATOR_AGENT_FORBIDDEN', 'Operator credentials cannot impersonate a board Agent.', 400)
    }
    const id = `principal-${randomUUID()}`
    const accepted = ManagementPrincipalSchema.parse({
      id, name, audience: input.audience, ...(input.agentId ? { agentId: input.agentId } : {}),
      grants, expiresAt: input.expiresAt.toISOString(), revokedAt: null,
    })
    const token = `opm_${randomBytes(32).toString('base64url')}`
    const result = await (client ?? this.pool).query<PrincipalRow>(
      `insert into management_principals (id, name, audience, agent_id, token_hash, grants, expires_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       returning id, name, audience, agent_id, token_hash, grants, expires_at, revoked_at`,
      [id, accepted.name, accepted.audience, accepted.agentId ?? null, digest(token), JSON.stringify(accepted.grants), input.expiresAt],
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
