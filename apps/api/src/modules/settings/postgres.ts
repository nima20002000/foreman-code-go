import {
  DEFAULT_HARNESS_DEFAULTS,
  HarnessDefaultsSchema,
  type HarnessDefaults,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

const SETTINGS_KEY = 'harness-defaults'

export class PostgresSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getHarnessDefaults(): Promise<HarnessDefaults> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from application_settings where key = $1',
      [SETTINGS_KEY],
    )
    const defaults = result.rows[0]
      ? HarnessDefaultsSchema.parse(result.rows[0].record)
      : DEFAULT_HARNESS_DEFAULTS
    // Older releases allowed this unusable template. Do not copy it into new
    // agents; existing versioned agent configurations remain untouched.
    return { ...defaults, opencode: { ...defaults.opencode, autoApprove: false } }
  }

  async saveHarnessDefaults(input: HarnessDefaults): Promise<HarnessDefaults> {
    const defaults = HarnessDefaultsSchema.parse(input)
    if (defaults.opencode.autoApprove) {
      throw new DomainError('OPENCODE_SETTING_UNSUPPORTED', 'Automatic permission approval is disabled for Product Agent runs.', 400)
    }
    await this.pool.query(
      `insert into application_settings (key, record, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update set record = excluded.record, updated_at = excluded.updated_at`,
      [SETTINGS_KEY, JSON.stringify(defaults)],
    )
    return defaults
  }
}
