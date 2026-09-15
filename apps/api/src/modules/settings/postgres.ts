import {
  DEFAULT_HARNESS_DEFAULTS,
  HarnessDefaultsSchema,
  type HarnessDefaults,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

const SETTINGS_KEY = 'harness-defaults'

/** Normalize legacy templates on read, never when validating an explicit write. */
export function normalizeHarnessDefaults(record: unknown): HarnessDefaults {
  const defaults = record === undefined ? DEFAULT_HARNESS_DEFAULTS : HarnessDefaultsSchema.parse(record)
  return { ...defaults, opencode: { ...defaults.opencode, autoApprove: false } }
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

  async getManagedHarnessDefaults(): Promise<{ defaults: HarnessDefaults; revision: number }> {
    const result = await this.pool.query<{ record: unknown; revision: string }>(
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
    if (defaults.opencode.autoApprove) {
      throw new DomainError('OPENCODE_SETTING_UNSUPPORTED', 'Automatic permission approval is disabled for Product Agent runs.', 400)
    }
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
    if (defaults.opencode.autoApprove) {
      throw new DomainError('OPENCODE_SETTING_UNSUPPORTED', 'Automatic permission approval is disabled for Product Agent runs.', 400)
    }
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
