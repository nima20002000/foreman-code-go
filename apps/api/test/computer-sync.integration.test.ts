import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ComputerSyncStatusSchema, SyncChannelRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerSyncService } from '../src/modules/computers/sync.js'
import { SyncthingComputer, sharedFolderId } from '../src/modules/computers/syncthingComputer.js'
import { fakeSyncthing, mainSyncId, workerSyncId } from './helpers/syncthing.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Syncthing through authenticated Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let mainId: string
  beforeAll(async () => {
    database = await agent3Database()
    mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  }, 60_000)
  afterAll(async () => { await database?.close() })
  async function fixture() {
    const access = new PostgresAccessService(database.pool)
    const commands = new PostgresCommandCoordinator(database.pool)
    const writer = await access.issue({ name: 'Sync writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await access.issue({ name: 'Sync reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] })
    const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
    await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
    [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    const target: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId, deviceId: registration.deviceId },
      applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const workspaceId = `workspace-${randomUUID()}`
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Client/Web' })])
    const agentId = `agent-${randomUUID()}`
    const configurationId = `config-${randomUUID()}`
    await database.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [agentId, workspaceId, JSON.stringify({ id: agentId, name: 'Worker' })])
    await database.pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,1,$4::jsonb)`, [configurationId, workspaceId, agentId,
      JSON.stringify({ harnessProfileSelection: { target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId } } })])
    await database.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agentId, configurationId])
    const main = await fakeSyncthing({ deviceId: mainSyncId, address: '100.64.0.1', rootPath: '/main/shared' })
    const worker = await fakeSyncthing({ deviceId: workerSyncId, address: '100.76.219.118', rootPath: '/worker/shared' })
    const local = new SyncthingComputer(main.ports)
    const remote = new SyncthingComputer(worker.ports)
    const endpoint = { capabilities: () => [{ namespace: 'computer-sync-v1', mainCanRequest: true }],
      request: async (_device: string, _namespace: string, payload: unknown) => ({ payload: await remote.handle(SyncChannelRequestSchema.parse(payload).request) }) }
    const createService = () => new ComputerSyncService(database.pool, mainId, () => endpoint, commands, local)
    const sync = createService()
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerSync: sync, commands } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (bearer: string) => {
      const client = new Client({ name: 'sync-integration', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }))
      return client
    }
    return { sync, createService, app, connect, target, writer, reader, workspaceId, main, worker, registration,
      close: async () => { await Promise.all(clients.map(client => client.close())); await app.close();
        await main.close(); await worker.close() } }
  }

  it('exchanges device IDs, persists on/off, discovers tools, denies writes and audits the MCP command', async () => {
    const f = await fixture()
    try {
      await f.sync.paired(f.target)
      const client = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_sync_update')
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_sync_update')
      const read = async () => ComputerSyncStatusSchema.parse((await client.callTool({
        name: 'computer_sync_status', arguments: { target: f.target },
      })).structuredContent).folders.find(folder => folder.workspaceId === f.workspaceId)!
      expect((await read()).status?.path).toBe(`/worker/shared/${sharedFolderId(f.workspaceId)}`)
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID() }
      expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      const denied = await f.app.inject({ method: 'POST', url: '/api/management/computers/sync/update',
        headers: { authorization: `Bearer ${f.reader.token}` }, payload: input })
      expect(denied.statusCode).toBe(403)
      expect((await client.callTool({ name: 'computer_sync_update', arguments: input })).isError).not.toBe(true)
      expect(await read()).toMatchObject({ enabled: false, revision: 1, status: null })
      expect((await f.createService().read(f.writer.principal, 'mcp', { target: f.target })).folders
        .find(folder => folder.workspaceId === f.workspaceId)).toMatchObject({ enabled: false, revision: 1 })
      await client.callTool({ name: 'computer_sync_update', arguments: input })
      expect((await read()).revision).toBe(1)
      expect((await client.callTool({ name: 'computer_sync_update', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
      await client.callTool({ name: 'computer_sync_update', arguments: { ...input, enabled: true,
        expectedRevision: 1, commandId: randomUUID() } })
      expect(await read()).toMatchObject({ enabled: true, revision: 2, status: { state: 'idle' } })
      const audits = await database.pool.query<{ action: string; outcome: string }>(
        'select action,outcome from management_audit where principal_id=$1', [f.writer.principal.id])
      expect(audits.rows).toEqual(expect.arrayContaining([
        { action: 'computer_sync_update', outcome: 'succeeded' }, { action: 'computer_sync_update', outcome: 'failed' },
      ]))
    } finally { await f.close() }
  })

  it('refuses an old computer registration and revoked writer before forwarding a sync change', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const input = { target: f.target, workspaceId: f.workspaceId, enabled: false, expectedRevision: 0, commandId: randomUUID() }
      await database.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [f.writer.principal.id])
      expect((await client.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
      expect(await f.worker.rest('GET', '/rest/config/folders')).toEqual([])
      f.registration.authorizationRevision++
      await database.pool.query('update device_registrations set record=$2::jsonb where id=$1',
        [f.registration.deviceId, JSON.stringify(f.registration)])
      await expect(f.sync.read(f.reader.principal, 'mcp', { target: f.target })).rejects.toThrow()
      expect((await database.pool.query('select * from computer_sync_preferences where workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    } finally { await f.close() }
  })
})
