import {
  DEFAULT_HARNESS_DEFAULTS,
  HarnessDefaultsSchema,
  withAdvancedDefaults,
  type HarnessDefaults,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

const SETTINGS_KEY = 'harness-defaults'

/** Complete legacy templates on read without changing their explicit permission choice. */
export function normalizeHarnessDefaults(record: unknown): HarnessDefaults {
  const candidate = (record === undefined ? DEFAULT_HARNESS_DEFAULTS : record) as HarnessDefaults
  const defaults = HarnessDefaultsSchema.parse(candidate)
  return { codex: withAdvancedDefaults(defaults.codex), opencode: withAdvancedDefaults(defaults.opencode) }
}

export class PostgresSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getHarnessDefaults(): Promise<HarnessDefaults> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from application_settings where key = $1',
      [SETTINGS_KEY],
    )
    return normalizeHarnessDefaults(result.rows[0]?.record)
  }

  async getManagedHarnessDefaults(client?: pg.ClientBase): Promise<{ defaults: HarnessDefaults; revision: number }> {
    const result = await (client ?? this.pool).query<{ record: unknown; revision: string }>(
      'select record, revision from application_settings where key = $1',
      [SETTINGS_KEY],
    )
    return {
      defaults: normalizeHarnessDefaults(result.rows[0]?.record),
      revision: Number(result.rows[0]?.revision ?? 0),
    }
  }

  async updateManagedHarnessDefaults(
    client: pg.PoolClient,
    input: HarnessDefaults,
    expectedRevision: number,
  ): Promise<{ defaults: HarnessDefaults; revision: number }> {
    const defaults = HarnessDefaultsSchema.parse(input)
    const current = await client.query<{ revision: string }>(
      'select revision from application_settings where key = $1 for update', [SETTINGS_KEY],
    )
    const revision = Number(current.rows[0]?.revision ?? 0)
    if (revision !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, { currentRevision: revision })
    }
    const result = await client.query<{ revision: string }>(
      `insert into application_settings (key, record, revision, updated_at)
       values ($1, $2::jsonb, 1, now())
       on conflict (key) do update set record = excluded.record,
         revision = application_settings.revision + 1, updated_at = excluded.updated_at
       where application_settings.revision = $3
       returning revision`,
      [SETTINGS_KEY, JSON.stringify(defaults), expectedRevision],
    )
    if (!result.rows[0]) {
      const latest = await client.query<{ revision: string }>(
        'select revision from application_settings where key = $1', [SETTINGS_KEY],
      )
      throw new DomainError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, {
        currentRevision: Number(latest.rows[0]?.revision ?? 0),
      })
    }
    return { defaults, revision: Number(result.rows[0].revision) }
  }

  async saveHarnessDefaults(input: HarnessDefaults): Promise<HarnessDefaults> {
    const defaults = HarnessDefaultsSchema.parse(input)
    await this.pool.query(
      `insert into application_settings (key, record, revision, updated_at)
       values ($1, $2::jsonb, 1, now())
       on conflict (key) do update set record = excluded.record,
         revision = application_settings.revision + 1, updated_at = excluded.updated_at`,
      [SETTINGS_KEY, JSON.stringify(defaults)],
    )
    return defaults
  }
}
