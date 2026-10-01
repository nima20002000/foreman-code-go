import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema, type HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { deviceIdentityMigration } from '../src/modules/devices/migration.js'
import { harnessInstanceSettingsMigration } from '../src/modules/harnesses/instanceSettings/migration.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { harnessInstanceProfileEvidenceMigration } from '../src/modules/harnesses/instanceSettings/profileMigration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'

it('persists host overrides through actual buildApp authenticated MCP and HTTP with denial, CAS, replay, cold readback and canonical revocation', async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Requires explicit owned TEST_DATABASE_URL.')
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `harness_instances_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  let app: ReturnType<typeof buildApp> | undefined
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    if (!(await pool.query("select to_regclass('device_registrations') as relation")).rows[0]?.relation) await pool.query(deviceIdentityMigration.sql)
    expect(migrations.some(migration => migration.version === harnessInstanceSettingsMigration.version)).toBe(true)
    expect((await pool.query("select to_regclass('harness_instance_settings') as relation")).rows[0]?.relation).toBeTruthy()
    expect(migrations.some(migration => migration.version === harnessInstanceProfileEvidenceMigration.version)).toBe(true)
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    const deviceId = randomUUID(), workerInstallationId = randomUUID()
    const registration = { mainId, deviceId, workerInstallationId, publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
    await pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)', [deviceId, mainId, workerInstallationId, 'fixture-public-key', JSON.stringify(registration)])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const settings = new HarnessInstanceSettingsRepository(pool), proofs = new HostHarnessProfileEvidenceRepository(pool)
    const authority = { authorize: async (principal: import('@graphql/contracts/management').ManagementPrincipal, action: 'harnesses:read' | 'harnesses:update', host: import('@graphql/contracts/device-identity').CanonicalMachineReference, installation: string, client?: pg.PoolClient) => {
      if (!client) throw new Error('Host authorization must share settings transaction.')
      await authorizeDeviceHost(client, principal, action, host, installation)
    } }
    let currentEnvironment = 'fixture-env-1'
    // Typed native-port replay: tests HTTP/MCP admission and persistence, never qualifies a physical CLI.
    const nativeReplay = vi.fn(async (value: import('@graphql/contracts/harness-registry').HostHarnessOverride, input: { checkId: string; signal: AbortSignal }): Promise<HostHarnessProfileEvidence> => {
      input.signal.throwIfAborted()
      return { target: value.target, instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
        driverId: value.driverId, driverRevision: 'fixture-driver', protocolRevision: 'fixture-protocol', suiteRevision: 'fixture-suite',
        environmentGeneration: currentEnvironment, connectionGeneration: 'fixture-connection', authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() }
    })
    const createService = () => new HostHarnessOverrideService(settings, commands, authority, async (value, client?: pg.PoolClient) => {
      const proof = await proofs.latest(value.instanceId, value.revision, client)
      if (!proof) return null
      return { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
        qualified: proof.authenticated === true && proof.compatible === true && proof.qualified === true && proof.driverId === value.driverId
          && proof.driverRevision === 'fixture-driver' && proof.protocolRevision === 'fixture-protocol' && proof.suiteRevision === 'fixture-suite'
          && proof.environmentGeneration === currentEnvironment && proof.connectionGeneration === 'fixture-connection' }
    }, new HostHarnessInstanceProfileChecks(settings, proofs, commands, authority, { qualify: nativeReplay }))
    let service = createService()
    const services = { commands, harnessInstances: {
      list: (...args: Parameters<HostHarnessOverrideService['list']>) => service.list(...args),
      save: (...args: Parameters<HostHarnessOverrideService['save']>) => service.save(...args),
      check: (...args: Parameters<HostHarnessOverrideService['check']>) => service.check(...args),
      get qualificationSupported() { return service.qualificationSupported },
    } } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    app.addHook('onClose', async () => { await service.closeChecks() })
    const owner = await access.issue({ name: 'writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => { const client = new Client({ name: 'host-instance-mcp', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    const writer = await connect(owner.token), denied = await connect(reader.token)
    expect((await writer.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['harness_instances_list', 'harness_instance_save', 'harness_instance_check']))
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
    await service.closeChecks()
    service = createService()
    const listed = HostHarnessOverrideListSchema.parse((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).structuredContent)
    expect(listed.overrides[0]).toMatchObject({ revision: 2, configuration: { model: 'changed' }, qualification: 'unqualified' })
    const http = await app.inject({ method: 'POST', url: '/api/management/harness-instances/read', headers: { authorization: `Bearer ${reader.token}` }, payload: listInput })
    expect(http.statusCode).toBe(200); expect(HostHarnessOverrideListSchema.parse(http.json())).toEqual(listed)
    const checkInput = { commandId: randomUUID(), instanceId: args.instanceId, expectedRevision: 2, target: args.target }
    const checked = HostHarnessInstanceCheckResultSchema.parse((await writer.callTool({ name: 'harness_instance_check', arguments: checkInput })).structuredContent)
    expect(checked).toMatchObject({ replayed: false, value: { revision: 2, qualification: 'qualified' }, proof: { instanceRevision: '2', qualified: true } })
    expect(HostHarnessInstanceCheckResultSchema.parse((await writer.callTool({ name: 'harness_instance_check', arguments: checkInput })).structuredContent).replayed).toBe(true)
    expect(nativeReplay).toHaveBeenCalledTimes(1)
    expect((await pool.query('select count(*)::int as count from harness_instance_profile_evidence')).rows[0].count).toBe(1)
    expect((await app.inject({ method: 'POST', url: '/api/management/harness-instances/check', headers: { authorization: `Bearer ${reader.token}` }, payload: checkInput })).statusCode).toBe(403)
    currentEnvironment = 'fixture-env-2'
    expect(HostHarnessOverrideListSchema.parse((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).structuredContent).overrides[0]?.qualification).toBe('unqualified')
    expect(nativeReplay).toHaveBeenCalledTimes(1) // Reading stale evidence never starts a replacement native check.
    expect((await app.inject({ method: 'POST', url: '/api/management/harness-instances/save', headers: { authorization: `Bearer ${reader.token}` }, payload: args })).statusCode).toBe(403)
    expect((await pool.query("select count(*)::int as count from management_audit where outcome='denied' and source='http' and action='harness_instance_save'")).rows[0].count).toBe(1)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...args, commandId: randomUUID(), instanceId: randomUUID(), target: { ...args.target, applicationInstallationId: randomUUID() } } })).isError).toBe(true)
    await pool.query('update device_registrations set record=$2::jsonb where id=$1', [deviceId, JSON.stringify({ ...registration, status: 'revoked', authorizationRevision: 2 })])
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: args })).isError).toBe(true)
    expect((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(2)
    expect(JSON.stringify((await pool.query('select record from harness_instance_settings')).rows)).not.toContain('credential')
  } finally {
    await Promise.all(clients.map(client => client.close())); await app?.close(); await pool.end()
    await admin.query(`drop schema "${schema}" cascade`); await admin.end()
  }
})
