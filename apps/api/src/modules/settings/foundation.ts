import { randomUUID } from 'node:crypto'

import {
  AgentDefaultsSchema,
  DEFAULT_AGENT_DEFAULTS,
  WorkflowDefaultsSchema,
  type AgentDefaults,
  type WorkflowDefaults,
} from '@graphql/contracts'
import type pg from 'pg'

import { inTransaction } from '../../infrastructure/transaction.js'

import { DomainError } from '../errors.js'

const KEYS = { agents: 'agent-defaults-v1', workflows: 'workflow-defaults-v1' } as const

const LEGACY_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  approvalHandler: 'orchestrator',
}

export interface VersionedSetting<T> { value: T; versionId: string | null; revision: number }

/** Versioned application defaults. Callers copy values; stored versions never mutate consumers. */
export class PostgresFoundationSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  getAgentDefaults(client?: pg.ClientBase): Promise<VersionedSetting<AgentDefaults>> {
    return this.read(KEYS.agents, AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, client)
  }

  getWorkflowDefaults(client?: pg.ClientBase): Promise<VersionedSetting<WorkflowDefaults>> {
    return this.read(KEYS.workflows, WorkflowDefaultsSchema, LEGACY_WORKFLOW_DEFAULTS, client)
  }

  updateAgentDefaults(value: AgentDefaults, expectedRevision: number, client?: pg.ClientBase) {
    return this.write(KEYS.agents, AgentDefaultsSchema.parse(value), expectedRevision, client)
  }

  updateWorkflowDefaults(value: WorkflowDefaults, expectedRevision: number, client?: pg.ClientBase) {
    return this.write(KEYS.workflows, WorkflowDefaultsSchema.parse(value), expectedRevision, client)
  }

  private async read<T>(key: string, schema: { parse(value: unknown): T }, fallback: T, client?: pg.ClientBase): Promise<VersionedSetting<T>> {
    const row = await (client ?? this.pool).query<{ record: unknown; revision: string; current_version_id: string | null }>(
      'select record, revision, current_version_id from application_settings where key = $1', [key],
    )
    return row.rows[0]
      ? { value: schema.parse(row.rows[0].record), revision: Number(row.rows[0].revision), versionId: row.rows[0].current_version_id }
      : { value: schema.parse(fallback), revision: 0, versionId: null }
  }

  private async write<T>(key: string, value: T, expectedRevision: number, supplied?: pg.ClientBase): Promise<VersionedSetting<T>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new DomainError('REVISION_INVALID', 'Expected revision must be a nonnegative integer.', 400)
    }
    return inTransaction(this.pool, supplied, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`setting:${key}`])
      const current = await client.query<{ revision: string }>(
        'select revision from application_settings where key = $1 for update', [key],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Defaults changed since they were read.', 409, { currentRevision: revision })
      const nextRevision = revision + 1
      const versionId = `${key}-v${nextRevision}-${randomUUID()}`
      await client.query(
        `insert into application_setting_versions (id, setting_key, version, record)
         values ($1, $2, $3, $4::jsonb)`, [versionId, key, nextRevision, JSON.stringify(value)],
      )
      await client.query(
        `insert into application_settings (key, record, revision, current_version_id, updated_at)
         values ($1, $2::jsonb, 1, $3, now())
         on conflict (key) do update set record = excluded.record,
           revision = application_settings.revision + 1, current_version_id = excluded.current_version_id,
           updated_at = excluded.updated_at`, [key, JSON.stringify(value), versionId],
      )
      return { value, revision: nextRevision, versionId }
    })
  }
}
