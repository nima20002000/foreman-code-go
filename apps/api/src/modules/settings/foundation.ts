import { randomUUID } from 'node:crypto'

import {
  AgentDefaultsSchema,
  DEFAULT_AGENT_DEFAULTS,
  WorkflowDefaultsSchema,
  type AgentDefaults,
  type WorkflowDefaults,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

const KEYS = { agents: 'agent-defaults-v1', workflows: 'workflow-defaults-v1' } as const

const LEGACY_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  approvalHandler: 'orchestrator',
}

export interface VersionedSetting<T> { value: T; versionId: string | null; revision: number }

/** Versioned application defaults. Callers copy values; stored versions never mutate consumers. */
export class PostgresFoundationSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  getAgentDefaults(): Promise<VersionedSetting<AgentDefaults>> {
    return this.read(KEYS.agents, AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS)
  }

  getWorkflowDefaults(): Promise<VersionedSetting<WorkflowDefaults>> {
    return this.read(KEYS.workflows, WorkflowDefaultsSchema, LEGACY_WORKFLOW_DEFAULTS)
  }

  updateAgentDefaults(value: AgentDefaults, expectedRevision: number) {
    return this.write(KEYS.agents, AgentDefaultsSchema.parse(value), expectedRevision)
  }

  updateWorkflowDefaults(value: WorkflowDefaults, expectedRevision: number) {
    return this.write(KEYS.workflows, WorkflowDefaultsSchema.parse(value), expectedRevision)
  }

  private async read<T>(key: string, schema: { parse(value: unknown): T }, fallback: T): Promise<VersionedSetting<T>> {
    const row = await this.pool.query<{ record: unknown; revision: string; current_version_id: string | null }>(
      'select record, revision, current_version_id from application_settings where key = $1', [key],
    )
    return row.rows[0]
      ? { value: schema.parse(row.rows[0].record), revision: Number(row.rows[0].revision), versionId: row.rows[0].current_version_id }
      : { value: fallback, revision: 0, versionId: null }
  }

  private async write<T>(key: string, value: T, expectedRevision: number): Promise<VersionedSetting<T>> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
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
      await client.query('commit')
      return { value, revision: nextRevision, versionId }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
