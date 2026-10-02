import { expect, it } from 'vitest'
import { OperatorConfigurationVersionSchema } from '@graphql/contracts'
import { ExecutionReadinessSchema } from '@graphql/contracts/management'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { DomainError } from '../src/modules/errors.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { buildApp } from '../src/app.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

// Real authenticated HTTP/MCP and persisted configuration; the native qualifier
// is the existing provider fixture, not evidence of a real Claude native turn.
it.skipIf(!postgresEnabled)('reads the exact persisted Operator readiness through HTTP and MCP without writes, and denies ungranted callers', async () => {
  const f = await currentOperatorIntegration()
  const operators = new PostgresOperatorRepository(f.db.pool)
  const settings = new PostgresFoundationSettingsRepository(f.db.pool)
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const { configuration } = await operators.ensure()
    const defaults = await settings.getAgentDefaults()
    const executionReadiness = new ExecutionReadinessService(new NativeRollout({}), f.services.harnesses, async (principal, id) => {
      const selected = id ? await f.db.pool.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1', [id]) : undefined
      if (id && !selected?.rows[0]) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The pinned configuration is missing.', 409)
      const current = id ? OperatorConfigurationVersionSchema.parse(selected!.rows[0]!.record)
        : await operators.inspectionConfiguration(defaults.revision)
      await f.services.harnesses.checkConfiguration(principal, current.harness)
      return { configurationVersionId: current.id, harness: current.harness, defaultsRevision: id ? null : defaults.revision }
    })
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: f.access, services: { ...f.services, executionReadiness } } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'operator-readiness-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(f.writer.token)
    const before = await f.db.pool.query('select id,record from operator_configuration_versions order by id')
    const read = async (id?: string) => {
      const result = await client.callTool({ name: 'execution_readiness_get', arguments: {
        harness: configuration.harness.harness, scope: 'operator-configuration', ...(id ? { configurationVersionId: id } : {}),
      } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return ExecutionReadinessSchema.parse(result.structuredContent)
    }
    expect(await read()).toMatchObject({ status: 'eligible', scope: 'operator-configuration', defaultsRevision: defaults.revision,
      configurationVersionId: configuration.id })
    expect(await read(configuration.id)).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id, defaultsRevision: null })
    expect(await read(configuration.id)).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    expect(await read('missing-config')).toMatchObject({ status: 'blocked', reason: { code: 'OPERATOR_CONFIGURATION_NOT_FOUND' } })
    const url = new URL(`/api/management/harnesses/${configuration.harness.harness}/execution-readiness`, address)
    url.searchParams.set('scope', 'operator-configuration'); url.searchParams.set('configurationVersionId', configuration.id)
    const response = await fetch(url, { headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(response.status).toBe(200)
    expect(ExecutionReadinessSchema.parse(await response.json())).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    const denied = await f.access.issue({ name: 'No readiness grant', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [] })
    expect((await fetch(url, { headers: { authorization: `Bearer ${denied.token}` } })).status).toBe(403)
    await expect((await connect(denied.token)).callTool({ name: 'execution_readiness_get', arguments: {
      harness: configuration.harness.harness, scope: 'operator-configuration',
    } })).rejects.toThrow('not found')
    expect((await f.db.pool.query('select id,record from operator_configuration_versions order by id')).rows).toEqual(before.rows)
    expect(await settings.getAgentDefaults()).toEqual(defaults)
  } finally { await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await f.close() }
}, 60000)
