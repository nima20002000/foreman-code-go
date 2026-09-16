import { createHash, randomUUID } from 'node:crypto'

import {
  DEFAULT_AGENT_DEFAULTS,
  OperatorAgentSchema,
  OperatorConfigurationVersionSchema,
  type HarnessConfiguration,
  type OperatorAgent,
  type OperatorConfigurationVersion,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

const OPERATOR_ID = 'application-operator'

function hash(value: unknown) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }

export class PostgresOperatorRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensure(): Promise<{ operator: OperatorAgent; configuration: OperatorConfigurationVersion }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['application-operator'])
      const found = await client.query<{ record: unknown; configuration: unknown }>(
        `select o.record, c.record as configuration from application_operators o
         join operator_configuration_versions c on c.id = o.current_configuration_version_id where o.id = $1`, [OPERATOR_ID],
      )
      if (found.rows[0]) {
        await client.query('commit')
        return { operator: OperatorAgentSchema.parse(found.rows[0].record), configuration: OperatorConfigurationVersionSchema.parse(found.rows[0].configuration) }
      }
      const createdAt = new Date().toISOString()
      const harness = DEFAULT_AGENT_DEFAULTS.operator.harness
      const configuration = OperatorConfigurationVersionSchema.parse({
        id: `${OPERATOR_ID}-config-v1-${randomUUID()}`, operatorId: OPERATOR_ID, version: 1,
        harness, contentHash: hash(harness), createdAt,
      })
      const operator = OperatorAgentSchema.parse({
        id: OPERATOR_ID, role: 'operator', name: 'Operator', currentConfigurationVersionId: configuration.id,
        createdAt, updatedAt: createdAt,
      })
      await client.query('set constraints all deferred')
      await client.query(
        'insert into application_operators (id, current_configuration_version_id, record) values ($1, $2, $3::jsonb)',
        [operator.id, configuration.id, JSON.stringify(operator)],
      )
      await client.query(
        `insert into operator_configuration_versions (id, operator_id, version, record)
         values ($1, $2, $3, $4::jsonb)`,
        [configuration.id, operator.id, configuration.version, JSON.stringify(configuration)],
      )
      await client.query('commit')
      return { operator, configuration }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  }

  async update(harness: HarnessConfiguration, expectedConfigurationVersionId: string) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
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
        harness, contentHash: hash(harness), createdAt,
      })
      await client.query('insert into operator_configuration_versions (id, operator_id, version, record) values ($1,$2,$3,$4::jsonb)', [configuration.id, OPERATOR_ID, version, JSON.stringify(configuration)])
      const next = OperatorAgentSchema.parse({ ...operator, currentConfigurationVersionId: configuration.id, updatedAt: createdAt })
      await client.query('update application_operators set current_configuration_version_id=$2, record=$3::jsonb, updated_at=now() where id=$1', [OPERATOR_ID, configuration.id, JSON.stringify(next)])
      await client.query('commit')
      return { operator: next, configuration }
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
}
