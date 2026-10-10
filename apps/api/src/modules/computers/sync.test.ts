import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
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
import { PostgresAppInteractionService } from '../interactions/app.js'
import { ComputerSyncService } from './sync.js'
import { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import type { DeviceApplicationRequestOptions } from '../devices/deviceApplicationChannel.js'
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
    request: async (deviceId: string, _namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) => {
      void options
      const index = targets.findIndex(target => target.hostRef.kind === 'device' && target.hostRef.deviceId === deviceId)
      const input = SyncChannelRequestSchema.parse(payload)
      return { payload: await computers[index]!.handle(input.request) }
    } }
  const createService = () => new ComputerSyncService(pool, mainId, () => endpoint, commands, computers[0])
  return { service: createService(), createService, targets, rest, computers, workspaces, hosts, devices,
    writer, reader, principals, preferences, denied, commands, pool, endpoint }
}

it('serves authenticated Agent context while optional shared-file installation is pending', async () => {
  const f = await fixture()
  const worker: ManagementPrincipal = { ...f.writer, id: 'worker', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: {
      workspaceIds: ['workspace-a'], workflowIds: ['workflow'], runIds: ['run'],
    } }] }
  f.principals.set(worker.id, worker)
  const access = new PostgresAccessService(f.pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = f.principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  const query = async (text: string) => {
    if (text.includes('workspaces w')) return { rows: [{ device_id: null, workspace_id: 'workspace-a' }] }
    if (text.includes('execution_native_placements')) return { rows: [] }
    return { rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }
  }
  const interactions = Object.assign(new PostgresAppInteractionService({ query } as unknown as pg.Pool,
    {} as never, {} as never), { syncedFolder: f.service.sharedFolder.bind(f.service) })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands: f.commands } as OperatorServices }, appMcp: { access, interactions } })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'pending-sync-context', version: '1' })
  cleanups.push(async () => { await client.close(); await app.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin),
    { requestInit: { headers: { authorization: 'Bearer worker' } } }))
  expect((await app.inject({ method: 'POST', url: '/mcp', headers: {
    authorization: 'Bearer invalid', accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  }, payload: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} },
  } })).statusCode).toBe(401)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const prepare = f.rest[0]!.ports.prepare
  const preparing = vi.spyOn(f.rest[0]!.ports, 'prepare').mockImplementation(async () => {
    await hold
    return prepare()
  })
  const setup = f.service.reconcile()
  let read: Promise<void> | undefined
  try {
    await vi.waitFor(() => { expect(preparing).toHaveBeenCalled() })
    const readback = vi.fn()
    read = client.callTool({ name: 'context_get', arguments: {} }).then(readback)
    await vi.waitFor(() => { expect(readback).toHaveBeenCalledWith(expect.objectContaining({
      structuredContent: expect.objectContaining({ principal: expect.objectContaining({ id: worker.id }) }),
    })) })
    await read
    expect(decodeMcpToolResult(readback.mock.calls[0]![0])).not.toHaveProperty('sharedFiles')
  } finally {
    release()
    await setup
    await read
  }
  const available = await client.callTool({ name: 'context_get', arguments: {} })
  expect(decodeMcpToolResult(available)).toMatchObject({ sharedFiles: { provider: 'syncthing',
    path: `/computer-0/shared/${sharedFolderId('workspace-a')}` } })
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let statusSignal: AbortSignal | undefined
  vi.spyOn(f.rest[0]!.ports, 'available').mockImplementation(async signal => {
    statusSignal = signal
    entered()
    return new Promise<never>((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  const slowContext = client.callTool({ name: 'context_get', arguments: {} })
  await started
  budget.abort(new DOMException('Context budget expired', 'TimeoutError'))
  const timedOut = decodeMcpToolResult(await slowContext)
  expect(timedOut).toMatchObject({ principal: { id: worker.id } })
  expect(timedOut).not.toHaveProperty('sharedFiles')
  expect(statusSignal?.aborted).toBe(true)
})

it('omits an unavailable optional shared folder and preserves unexpected failures', async () => {
  const f = await fixture()
  const handle = vi.spyOn(f.computers[0]!, 'handle')
    .mockRejectedValue(new DomainError('SYNC_UNAVAILABLE', 'Shared files are unavailable.', 502))
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBeNull()
  handle.mockRejectedValue(new DeviceApplicationError('timeout'))
  expect(await f.service.sharedFolder('workspace-a', { kind: 'main' })).toBeNull()
  handle.mockRejectedValue(new DeviceApplicationError('extension-rejected'))
  await expect(f.service.sharedFolder('workspace-a', { kind: 'main' })).rejects.toThrow('extension-rejected')
  handle.mockRejectedValue(new Error('Unexpected configuration error'))
  await expect(f.service.sharedFolder('workspace-a', { kind: 'main' }))
    .rejects.toThrow('Unexpected configuration error')
})

it('stops offering a disabled workspace folder while a computer has not applied the change', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const handle = f.computers[1]!.handle.bind(f.computers[1]!)
  vi.spyOn(f.computers[1]!, 'handle').mockImplementation(async request => {
    const input = SyncChannelRequestSchema.shape.request.parse(request)
    if (input.operation === 'configure') throw new DomainError('SYNC_UNAVAILABLE', 'Setup is pending.', 502)
    return handle(request)
  })
  await f.service.update(f.writer, 'mcp', { target: f.targets[0], workspaceId: 'workspace-a', enabled: false,
    expectedRevision: 0, commandId: randomUUID() })
  expect(await f.rest[1]!.rest('GET', '/rest/config/folders')).toHaveLength(1)
  expect(await f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })).toBeNull()
})

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
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(saved)).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const persisted = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(persisted)).folders[0]).toMatchObject({ enabled: false, revision: 1 })
  const enabled = await updateOnly.callTool({ name: 'computer_sync_update', arguments: {
    ...input, expectedRevision: 1, enabled: true, commandId: randomUUID(),
  } })
  expect(enabled.isError).not.toBe(true)
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(enabled)).folders[0]).toMatchObject({ enabled: true, revision: 2 })
  expect((await updateOnly.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })).isError).toBe(true)
  const enabledReadback = await reader.callTool({ name: 'computer_sync_status', arguments: { target: f.targets[1] } })
  expect(ComputerSyncStatusSchema.parse(decodeMcpToolResult(enabledReadback)).folders[0])
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

it('defers membership replacement after restart while an enabled peer identity is unavailable', async () => {
  const f = await fixture()
  await f.service.reconcile()
  const folders = await f.rest[0]!.rest('GET', '/rest/config/folders')
  vi.spyOn(f.endpoint, 'request').mockRejectedValue(new DomainError('COMPUTER_OFFLINE', 'Offline.', 409))
  const restarted = f.createService()
  await expect(restarted.reconcile()).rejects.toThrow('Shared file setup is pending')
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(folders)
  await restarted.update(f.writer, 'mcp', { target: f.targets[1], workspaceId: 'workspace-a',
    enabled: false, expectedRevision: 0, commandId: randomUUID() })
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), devices: [{ deviceID: mainSyncId }] }),
  ]))
})

it('removes a revoked peer from Main after restart even while its app is unavailable', async () => {
  const f = await fixture()
  await f.service.reconcile()
  f.devices.splice(0, 1)
  vi.spyOn(f.endpoint, 'request').mockRejectedValue(new DomainError('COMPUTER_OFFLINE', 'Offline.', 409))
  await expect(f.createService().reconcile()).rejects.toThrow('Shared file setup is pending')
  expect(await f.rest[0]!.rest('GET', '/rest/config/folders')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sharedFolderId('workspace-a'), devices: [{ deviceID: mainSyncId }] }),
  ]))
})

it('omits slow local shared-folder status at the context budget and stops further status work', async () => {
  const f = await fixture()
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let release!: () => void
  let entered!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let localSignal: AbortSignal | undefined
  vi.spyOn(f.rest[0]!.ports, 'available').mockImplementation(async signal => {
    localSignal = signal
    entered()
    await hold
    return { installed: true, running: true }
  })
  const rest = vi.spyOn(f.rest[0]!.ports, 'rest')
  const read = f.service.sharedFolder('workspace-a', { kind: 'main' })
  try {
    await started
    budget.abort(new DOMException('Context budget expired', 'TimeoutError'))
    expect(await read).toBeNull()
    expect(localSignal?.aborted).toBe(true)
  } finally {
    release()
    await read
  }
  await Promise.resolve()
  expect(rest).not.toHaveBeenCalled()
})

it('forwards the same shared-folder budget to remote status requests', async () => {
  const f = await fixture()
  const budget = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === 10_000 ? budget.signal : timeout(milliseconds))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let remoteSignal: AbortSignal | undefined
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (_deviceId, _namespace, _payload, options) => {
    remoteSignal = options!.signal
    entered()
    return new Promise<never>((_, reject) => {
      remoteSignal!.addEventListener('abort', () => reject(new DeviceApplicationError('timeout')), { once: true })
    })
  })
  const read = f.service.sharedFolder('workspace-a', { kind: 'device', deviceId: f.devices[0]!.deviceId })
  await started
  expect(remoteSignal).toBe(budget.signal)
  budget.abort(new DOMException('Context budget expired', 'TimeoutError'))
  expect(await read).toBeNull()
})
