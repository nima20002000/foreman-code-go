import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { expect, it } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema } from '@graphql/contracts/harness-registry'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { deviceIdentityMigration } from '../src/modules/devices/migration.js'
import { harnessInstanceSettingsMigration } from '../src/modules/harnesses/instanceSettings/migration.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { registerHostHarnessOverrideRoutes, registerHostHarnessOverrideTools } from '../src/modules/harnesses/instanceSettings/management.js'

it('persists host overrides through authenticated MCP and HTTP with denial, CAS, replay, cold readback and canonical revocation', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Requires explicit owned TEST_DATABASE_URL.')
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `harness_instances_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const app = Fastify(); const clients: Client[] = []
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof Error ? error.message : 'Failed' }))
  try {
    await applyApplicationMigrations(pool)
    if (!(await pool.query("select to_regclass('device_registrations') as relation")).rows[0]?.relation) await pool.query(deviceIdentityMigration.sql)
    if (!(await pool.query("select to_regclass('harness_instance_settings') as relation")).rows[0]?.relation) await pool.query(harnessInstanceSettingsMigration.sql)
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    const deviceId = randomUUID(), workerInstallationId = randomUUID()
    const registration = { mainId, deviceId, workerInstallationId, publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
    await pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)', [deviceId, mainId, workerInstallationId, 'fixture-public-key', JSON.stringify(registration)])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const createService = () => new HostHarnessOverrideService(new HarnessInstanceSettingsRepository(pool), commands,
      { authorize: async (principal, action, host, installation, client) => {
        if (!client) throw new Error('Host authorization must share settings transaction.')
        await authorizeDeviceHost(client, principal, action, host, installation)
      } })
    let service = createService()
    const authenticate = async (request: import('fastify').FastifyRequest) => access.authenticate(/^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1], ['operator'])
    registerHostHarnessOverrideRoutes(app, { list: (...args) => service.list(...args), save: (...args) => service.save(...args) } as HostHarnessOverrideService, authenticate)
    app.post('/mcp', async (request, reply) => {
      const principal = await authenticate(request)
      const server = new McpServer({ name: 'harness-instance-test', version: '1' })
      registerHostHarnessOverrideTools(server, service, principal)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
      await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    const owner = await access.issue({ name: 'writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => { const client = new Client({ name: 'host-instance-mcp', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    const writer = await connect(owner.token), denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_instance_save')
    await expect(denied.callTool({ name: 'harness_instance_save', arguments: {} })).rejects.toThrow('not found')
    const hostRef = { kind: 'device', mainId, deviceId }
    const args = { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target: { hostRef, applicationInstallationId: workerInstallationId, harnessInstallationId: 'codex-native', installationFingerprint: 'sha' }, presetId: 'local-default:codex', enabled: true,
      configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' } }
    const first = HostHarnessOverrideSaveResultSchema.parse((await writer.callTool({ name: 'harness_instance_save', arguments: args })).structuredContent)
    expect(first).toMatchObject({ replayed: false, value: { revision: 1, qualification: 'unqualified' } })
    const replay = HostHarnessOverrideSaveResultSchema.parse((await writer.callTool({ name: 'harness_instance_save', arguments: args })).structuredContent)
    expect(replay.value).toEqual(first.value); expect(replay.replayed).toBe(true)
    const secondArgs = { ...args, commandId: randomUUID(), expectedRevision: 1, configuration: { ...args.configuration, model: 'changed' } }
    expect(HostHarnessOverrideSaveResultSchema.parse((await writer.callTool({ name: 'harness_instance_save', arguments: secondArgs })).structuredContent).value.revision).toBe(2)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...secondArgs, commandId: randomUUID() } })).isError).toBe(true)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...secondArgs, commandId: randomUUID(), expectedRevision: 2, target: { ...args.target, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId } } })).isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(2)
    const listInput = { hostRef, applicationInstallationId: workerInstallationId }
    service = createService()
    const listed = HostHarnessOverrideListSchema.parse((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).structuredContent)
    expect(listed.overrides[0]).toMatchObject({ revision: 2, configuration: { model: 'changed' }, qualification: 'unqualified' })
    const http = await app.inject({ method: 'POST', url: '/api/management/harness-instances/read', headers: { authorization: `Bearer ${reader.token}` }, payload: listInput })
    expect(http.statusCode).toBe(200); expect(HostHarnessOverrideListSchema.parse(http.json())).toEqual(listed)
    expect((await app.inject({ method: 'POST', url: '/api/management/harness-instances/save', headers: { authorization: `Bearer ${reader.token}` }, payload: args })).statusCode).toBe(403)
    expect((await pool.query("select count(*)::int as count from management_audit where outcome='denied' and source='http' and action='harness_instance_save'")).rows[0].count).toBe(1)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...args, commandId: randomUUID(), instanceId: randomUUID(), target: { ...args.target, applicationInstallationId: randomUUID() } } })).isError).toBe(true)
    await pool.query('update device_registrations set record=$2::jsonb where id=$1', [deviceId, JSON.stringify({ ...registration, status: 'revoked', authorizationRevision: 2 })])
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: args })).isError).toBe(true)
    expect((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(2)
    expect(JSON.stringify((await pool.query('select record from harness_instance_settings')).rows)).not.toContain('credential')
  } finally {
    await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
})
