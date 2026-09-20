import { createHash, randomUUID } from 'node:crypto'

import {
  HarnessConfigurationSchema,
  OperatorAgentSchema,
  OperatorConfigurationVersionSchema,
  type HarnessConfiguration,
  type OperatorAgent,
  type OperatorConfigurationVersion,
} from '@graphql/contracts'
import type pg from 'pg'

import { inTransaction } from '../../infrastructure/transaction.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'

import { DomainError } from '../errors.js'

const OPERATOR_ID = 'application-operator'

// Sort provider-owned map keys too: schema parsing normalizes fields, not record key order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}
function hash(value: HarnessConfiguration) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}` }

export class PostgresOperatorRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Read-only inspection must not create an Operator before a conversation exists. */
  async inspectionConfiguration(expectedDefaultsRevision?: number): Promise<OperatorConfigurationVersion> {
    const found = await this.pool.query<{ record: unknown; defaults_revision: string | number }>(
      `select c.record,coalesce((select revision from application_settings where key='agent-defaults-v1'),0) as defaults_revision
       from application_operators o join operator_configuration_versions c
       on c.id=o.current_configuration_version_id where o.id=$1`, [OPERATOR_ID])
    if (found.rows[0]) {
      if (expectedDefaultsRevision !== undefined && Number(found.rows[0].defaults_revision) !== expectedDefaultsRevision) {
        throw new DomainError('OPERATOR_DEFAULTS_CHANGED', 'Operator defaults changed. Refresh the saved settings before sending.', 409)
      }
      return OperatorConfigurationVersionSchema.parse(found.rows[0].record)
    }
    const snapshot = await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults()
    if (expectedDefaultsRevision !== undefined && snapshot.revision !== expectedDefaultsRevision) {
      throw new DomainError('OPERATOR_DEFAULTS_CHANGED', 'Operator defaults changed. Refresh the saved settings before sending.', 409)
    }
    const defaults = snapshot.value.operator
    return OperatorConfigurationVersionSchema.parse({ id: `${OPERATOR_ID}-inspection`, operatorId: OPERATOR_ID, version: 1,
      harness: defaults.harness, showThinking: defaults.showThinking ?? false, contentHash: hash(defaults.harness),
      createdAt: new Date().toISOString() })
  }

  async ensure(supplied?: pg.ClientBase): Promise<{ operator: OperatorAgent; configuration: OperatorConfigurationVersion }> {
    return inTransaction(this.pool, supplied, (client) => this.ensureWithClient(client))
  }

  async ensureWithClient(client: pg.ClientBase): Promise<{ operator: OperatorAgent; configuration: OperatorConfigurationVersion }> {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
    const found = await client.query<{ record: unknown; configuration: unknown }>(
      `select o.record, c.record as configuration from application_operators o
       join operator_configuration_versions c on c.id = o.current_configuration_version_id where o.id = $1`, [OPERATOR_ID],
    )
    if (found.rows[0]) {
      return { operator: OperatorAgentSchema.parse(found.rows[0].record), configuration: OperatorConfigurationVersionSchema.parse(found.rows[0].configuration) }
    }
    const createdAt = new Date().toISOString()
    const defaults = (await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults(client)).value.operator
    const harness = defaults.harness
    const configuration = OperatorConfigurationVersionSchema.parse({
      id: `${OPERATOR_ID}-config-v1-${randomUUID()}`, operatorId: OPERATOR_ID, version: 1,
      harness, showThinking: defaults.showThinking ?? false, contentHash: hash(harness), createdAt,
    })
    const operator = OperatorAgentSchema.parse({
      id: OPERATOR_ID, role: 'operator', name: 'Operator', currentConfigurationVersionId: configuration.id,
      createdAt, updatedAt: createdAt,
    })
    await client.query(
      'insert into application_operators (id, current_configuration_version_id, record) values ($1, $2, $3::jsonb)',
      [operator.id, configuration.id, JSON.stringify(operator)],
    )
    await client.query(
      `insert into operator_configuration_versions (id, operator_id, version, record)
       values ($1, $2, $3, $4::jsonb)`,
      [configuration.id, operator.id, configuration.version, JSON.stringify(configuration)],
    )
    return { operator, configuration }
  }

  async update(input: HarnessConfiguration, expectedConfigurationVersionId: string, supplied?: pg.ClientBase) {
    const harness = HarnessConfigurationSchema.parse(input)
    return inTransaction(this.pool, supplied, (client) => this.updateWithClient(client, harness, expectedConfigurationVersionId))
  }

  async updateWithClient(client: pg.ClientBase, harness: HarnessConfiguration, expectedConfigurationVersionId: string, showThinking = false) {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
      const row = await client.query<{ record: unknown; current_configuration_version_id: string }>(
        'select record, current_configuration_version_id from application_operators where id = $1 for update', [OPERATOR_ID],
      )
      const operator = OperatorAgentSchema.parse(row.rows[0]?.record)
      if (row.rows[0]?.current_configuration_version_id !== expectedConfigurationVersionId) {
        throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'Operator settings changed since they were read.', 409)
      }
      const versionRow = await client.query<{ version: number }>('select coalesce(max(version), 0) + 1 as version from operator_configuration_versions where operator_id = $1', [OPERATOR_ID])
      const version = Number(versionRow.rows[0]?.version ?? 1)
      const createdAt = new Date().toISOString()
      const configuration = OperatorConfigurationVersionSchema.parse({
        id: `${OPERATOR_ID}-config-v${version}-${randomUUID()}`, operatorId: OPERATOR_ID, version,
        harness, showThinking, contentHash: `sha256:${createHash('sha256').update(JSON.stringify({ harness: canonical(harness), showThinking })).digest('hex')}`, createdAt,
      })
      await client.query('insert into operator_configuration_versions (id, operator_id, version, record) values ($1,$2,$3,$4::jsonb)', [configuration.id, OPERATOR_ID, version, JSON.stringify(configuration)])
      const next = OperatorAgentSchema.parse({ ...operator, currentConfigurationVersionId: configuration.id, updatedAt: createdAt })
      await client.query('update application_operators set current_configuration_version_id=$2, record=$3::jsonb, updated_at=now() where id=$1', [OPERATOR_ID, configuration.id, JSON.stringify(next)])
      return { operator: next, configuration }
  }
}
