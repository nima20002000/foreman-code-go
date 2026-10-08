import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ComputerSyncStatusSchema, SyncChannelRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { ComputerSyncService } from './sync.js'
import { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'
import { fakeSyncthing, mainSyncId, workerSyncId } from '../../../test/helpers/syncthing.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.restoreAllMocks() })
async function fixture() {
  const mainId = randomUUID()
  const devices = [randomUUID(), randomUUID()].map(deviceId => ({ mainId, deviceId,
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
    publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }))
  const targets: DeviceProvisioningTarget[] = [{ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, ...devices.map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId }, applicationInstallationId: device.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1 }))]
  const rest = await Promise.all([mainSyncId, workerSyncId, Array(8).fill('CCCCCCC').join('-')].map((deviceId, index) =>
    fakeSyncthing({ deviceId, address: `100.64.0.${index + 1}`, rootPath: `/computer-${index}/shared` })))
  cleanups.push(...rest.map(server => server.close))
  const computers = rest.map(server => new SyncthingComputer(server.ports))
  const writer: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z',
    revokedAt: null, grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] }
  const reader: ManagementPrincipal = { ...writer, id: 'reader', grants: [{ actions: ['settings:read'], scope: {} }] }
  const updateOnly: ManagementPrincipal = { ...writer, id: 'update-only',
    grants: [{ actions: ['settings:update'], scope: {} }] }
  const principals = new Map([['writer', writer], ['reader', reader], ['update-only', updateOnly]])
  const preferences = new Map<string, { target: DeviceProvisioningTarget; revision: string; enabled: boolean }>()
  const workspaces = [{ id: 'workspace-a', name: 'Client/Web', active: true }, { id: 'workspace-b', name: 'Client-Web', active: true }]
  const hosts = [{ workspace_id: 'workspace-a', host: targets[1]!.hostRef,
    installation_id: targets[1]!.applicationInstallationId, key_revision: null, authorization_revision: null }]
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (text.includes('from management_principals')) {
      const principal = principals.get(values[0] as string)
      return { rows: principal ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null }] : [] }
    }
    if (text.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (text.includes('from device_registrations')) {
      return { rows: devices.filter(device => !text.includes('where id=') || device.deviceId === values[0]).map(record => ({ record })) }
    }
    if (text.includes('from agents')) return { rows: hosts }
    if (text.includes('from workspaces')) return { rows: values.length ? workspaces.filter(row => row.id === values[0]) : workspaces }
    const key = `${values[0]}:${values[1]}`
    if (text.includes('select target,revision')) return { rows: preferences.has(key) ? [preferences.get(key)!] : [] }
    if (text.includes('insert into computer_sync_preferences')) {
      preferences.set(key, { target: JSON.parse(values[2] as string) as DeviceProvisioningTarget,
        revision: String(values[3]), enabled: values[4] as boolean })
    }
    return { rows: [] }
  }
  const sql = { query, release() {} }
  const pool = { query, connect: async () => sql } as unknown as pg.Pool
  const receipts = new Map<string, { payload: string; value: unknown }>()
  const denied = vi.fn().mockResolvedValue(undefined)
  const commands = { recordDenied: denied, execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.authorize?.(sql as unknown as pg.PoolClient)
    const old = receipts.get(input.commandId)
    if (old) {
      if (old.payload !== JSON.stringify(input.payload)) throw new DomainError('COMMAND_ID_CONFLICT', 'Changed input.', 409)
      return { value: old.value, replayed: true }
    }
    const value = await input.perform(sql as unknown as pg.PoolClient)
    receipts.set(input.commandId, { payload: JSON.stringify(input.payload), value })
    return { value, replayed: false }
  } } as unknown as PostgresCommandCoordinator
  const endpoint = { capabilities: () => [{ namespace: 'computer-sync-v1', mainCanRequest: true }],
    request: async (deviceId: string, _namespace: string, payload: unknown) => {
      const index = targets.findIndex(target => target.hostRef.kind === 'device' && target.hostRef.deviceId === deviceId)
      const input = SyncChannelRequestSchema.parse(payload)
      return { payload: await computers[index]!.handle(input.request) }
    } }
  const createService = () => new ComputerSyncService(pool, mainId, () => endpoint, commands, computers[0])
  return { service: createService(), createService, targets, rest, workspaces, hosts, devices,
    writer, reader, principals, preferences, denied, commands, pool }
}

it('pairs automatically through the channel and shares each workspace only with its participating computers', async () => {
  const f = await fixture()
  await f.service.paired(f.targets[1]!)
  const mainFolders = await f.rest[0]!.rest('GET', '/rest/config/folders') as { id: string; devices: unknown[] }[]
  expect(mainFolders.find(folder => folder.id === sharedFolderId('workspace-a'))?.devices)
    .toEqual([{ deviceID: mainSyncId }, { deviceID: workerSyncId }])
  expect(mainFolders.find(folder => folder.id === sharedFolderId('workspace-b'))?.devices).toEqual([{ deviceID: mainSyncId }])
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toHaveLength(1)
  expect(await f.rest[2]!.rest('GET', '/rest/config/folders')).toEqual([])
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId }))
    .toBe(`/computer-1/shared/${sharedFolderId('workspace-a')}`)
  f.workspaces[0]!.name = 'Renamed client'
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBe(`/computer-0/shared/${sharedFolderId('workspace-a')}`)
  f.hosts.length = 0
  await f.service.reconcile()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([])
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
})

it('persists enabled preferences, checks revisions, retries commands and survives service restart', async () => {
  const f = await fixture()
  const input = { target: f.targets[1], workspaceId: 'workspace-a', enabled: false, expectedRevision: 0, commandId: randomUUID() }
  const saved = await f.service.update(f.writer, 'http', input)
  expect(saved.folders[0]).toMatchObject({ enabled: false, revision: 1, status: null })
  expect((await f.createService().read(f.writer, 'mcp', { target: f.targets[1] })).folders[0])
    .toMatchObject({ enabled: false, revision: 1 })
  await f.service.update(f.writer, 'mcp', input)
  await expect(f.service.update(f.writer, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const enabled = await f.service.update(f.writer, 'mcp', { ...input, enabled: true, expectedRevision: 1, commandId: randomUUID() })
  expect(enabled.folders[0]).toMatchObject({ enabled: true, revision: 2, status: { state: 'idle' } })
  f.devices[0]!.authorizationRevision++
  await expect(f.service.update(f.writer, 'mcp', { ...input, commandId: randomUUID() })).rejects.toThrow()
})

it('supports authenticated MCP discovery, denied callers and persisted readback through the same HTTP service', async () => {
  const f = await fixture()
  const access = new PostgresAccessService(f.pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = f.principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { computerSync: f.service, commands: f.commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  cleanups.push(async () => { await Promise.all(clients.map(client => client.close())); await app.close() })
  const connect = async (token: string) => {
    const client = new Client({ name: 'sync-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return client
  }
  const writer = await connect('writer')
  const reader = await connect('reader')
  const updateOnly = await connect('update-only')
  expect((await writer.listTools()).tools.map(tool => tool.name)).toContain('computer_sync_update')
  expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_sync_update')
  const input = { target: f.targets[1], workspaceId: 'workspace-a', enabled: false, expectedRevision: 0, commandId: randomUUID() }
  expect((await reader.callTool({ name: 'computer_sync_update', arguments: input })).isError).toBe(true)
  const denied = await app.inject({ method: 'POST', url: '/api/management/computers/sync/update',
    headers: { authorization: 'Bearer reader' }, payload: input })
  expect(denied.statusCode, JSON.stringify(denied.json())).toBe(403)
  const saved = await writer.callTool({ name: 'computer_sync_update', arguments: input })
  expect(ComputerSyncStatusSchema.parse(saved.structuredContent).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const persisted = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(persisted.structuredContent).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const enabled = await updateOnly.callTool({ name: 'computer_sync_update', arguments: {
    ...input, expectedRevision: 1, enabled: true, commandId: randomUUID(),
  } })
  expect(enabled.isError).not.toBe(true)
  expect(ComputerSyncStatusSchema.parse(enabled.structuredContent).folders[0]).toMatchObject({ enabled: true, revision: 2 })
  expect((await updateOnly.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })).isError).toBe(true)
  const enabledReadback = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(enabledReadback.structuredContent).folders[0])
    .toMatchObject({ enabled: true, revision: 2 })
  f.principals.set('writer', { ...f.writer, grants: [] })
  await expect(f.service.update(f.writer, 'mcp', { ...input, expectedRevision: 2, enabled: false,
    commandId: randomUUID() })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.preferences.values().next().value?.enabled).toBe(true)
})

it('removes sharing after archive or Main disable and never gives a replacement installation the old folder', async () => {
  const f = await fixture()
  await f.service.paired(f.targets[1]!)
  f.hosts[0]!.installation_id = randomUUID()
  await f.service.reconcile()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([])
  f.hosts[0]!.installation_id = f.targets[1]!.applicationInstallationId
  await f.service.update(f.writer, 'mcp', { target: f.targets[0], workspaceId: 'workspace-a', enabled: false,
    expectedRevision: 0, commandId: randomUUID() })
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toEqual([])
  f.workspaces[1]!.active = false
  await f.service.reconcile()
  expect((await f.service.read(f.reader, 'mcp', { target: f.targets[0] })).folders.map(folder => folder.workspaceId))
    .toEqual(['workspace-a'])
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual([])
})
