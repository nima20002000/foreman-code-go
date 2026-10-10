import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { COMPUTER_ACCOUNTS_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { COMPUTER_MAINTENANCE_NAMESPACE, MaintenanceRequestSchema,
  ComputerMaintenanceOperatorListSchema, ComputerMaintenanceListSchema, type MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { FleetMaintenanceService, type FleetSources } from '../src/modules/computers/fleet.js'
import { DomainError } from '../src/modules/errors.js'
import { fakeComputer } from './helpers/fleetSync.js'

afterEach(() => vi.restoreAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const mainId = randomUUID()
  const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] }
  const reader: ManagementPrincipal = { ...owner, id: 'reader',
    grants: [{ actions: ['settings:read'], scope: {} }] }
  const scoped: ManagementPrincipal = { ...owner, id: 'scoped',
    grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['workspace'] } }] }
  const principals = [owner, reader, scoped]
  const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'],
    publicKeyFingerprint: 'a'.repeat(64) }
  const main: DeviceProvisioningTarget = { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  const worker: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId, deviceId: registration.deviceId },
    applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const sql = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes('from management_principals')) {
        const principal = principals.find(item => item.id === values[0])!
        return { rows: [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null }] }
      }
      return { rows: [{ record: registration }] }
    },
    release() {},
  }
  const pool = { connect: async () => sql } as unknown as pg.Pool
  const commands = {
    recordDenied: vi.fn(async () => {}),
    execute: async (input: { prepare?: () => Promise<void>; authorize?: (sql: unknown) => Promise<void>;
      perform: () => Promise<unknown> }) => {
      await input.prepare?.()
      await input.authorize?.(sql)
      return { value: await input.perform(), replayed: false }
    },
  } as unknown as PostgresCommandCoordinator
  const computer = fakeComputer()
  let version = '1.2.3'
  const run = computer.ports.run
  computer.ports.find = async name => ['codex', 'claude', 'npm'].includes(name) ? `/fake/${name}` : null
  computer.ports.run = async (binary, args, options) => {
    if (args[0] === 'view') return { code: 0, stdout: '1.2.4', stderr: '' }
    if (args[0] === 'install') {
      version = '1.2.5'
      return { code: 0, stdout: 'Installed 1.2.5', stderr: '' }
    }
    if (args[0] === '--version') return { code: 0, stdout: version, stderr: '' }
    return run(binary, args, options)
  }
  let local = new ComputerMaintenance(computer.ports)
  const accountFacts = { accounts: [{ tool: 'codex' as const, installed: true, signedIn: true,
    account: 'fixture@example.com', details: [] }], observedAt: '2026-10-10T00:00:00Z' }
  const mainAccounts = vi.fn(async () => accountFacts)
  const mainStatus = vi.fn((signal: AbortSignal) => local.status(signal))
  const requests: { deviceId: string; namespace: string; payload: unknown }[] = []
  const endpoint = {
    capabilities: () => [COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_MAINTENANCE_NAMESPACE]
      .map(namespace => ({ namespace, mainCanRequest: true })),
    request: async (deviceId: string, namespace: string, payload: unknown) => {
      requests.push({ deviceId, namespace, payload })
      if (namespace === COMPUTER_ACCOUNTS_NAMESPACE) return { payload: accountFacts }
      const request = MaintenanceRequestSchema.parse(payload)
      if (request.operation === 'status') {
        return { payload: { operation: 'status', status: await local.status(AbortSignal.timeout(1000)) } }
      }
      return { payload: { operation: 'start', task: await local.start(request.task, request.commandId) } }
    },
  }
  const sources: FleetSources = {
    codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
    codexPlugins: async () => [], codexMarketplaces: async () => [],
    claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
  }
  const accounts = new ComputerAccountsService(pool, mainId, () => endpoint, commands, mainAccounts)
  const localMaintenance = {
    status: mainStatus,
    start: (...args: Parameters<ComputerMaintenance['start']>) => local.start(...args),
  } as unknown as ComputerMaintenance
  const maintenance = new FleetMaintenanceService(pool, mainId, () => endpoint, commands,
    localMaintenance, sources)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = principals.find(item => item.id === token)
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return principal
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: {
      commands, computerAccounts: accounts, computerMaintenance: maintenance,
    } as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'computer-target-fixture', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  return { app, address, connect, commands, main, worker, registration, requests, sources, mainAccounts, mainStatus,
    maintenance, status: () => local.status(AbortSignal.timeout(1000)),
    restart: () => { local = new ComputerMaintenance(computer.ports) },
    drain: () => local.drain(),
    close: async () => {
      await Promise.all(clients.map(client => client.close()))
      await app.close()
    } }
}

describe('authenticated computer target reads and maintenance', () => {
  it('defaults to compact history and allows authorized full and task-specific reads without changing HTTP', async () => {
    const f = await fixture()
    try {
      const now = Date.now()
      const task = (hoursAgo: number, state: MaintenanceTask['state'] = 'succeeded',
        kind: MaintenanceTask['kind'] = 'update-system'): MaintenanceTask => ({
        id: randomUUID(), kind, state,
        startedAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
        finishedAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
        summary: 'Maintenance outcome '.repeat(40), outputTail: 'Diagnostic output '.repeat(400),
      })
      const latest = task(1)
      const recentFailure = task(2, 'failed')
      const latestRestart = task(30, 'failed', 'restart')
      // Completion time determines the failure window, even for a long-running task.
      const longFailure = { ...task(40, 'failed'), finishedAt: task(3).finishedAt }
      const tasks = [task(48, 'failed'), latestRestart, longFailure, task(25, 'failed'),
        task(4), recentFailure, latest]
      const snapshot = { ...await f.status(), tasks, worker: {
        currentVersion: '1.2.3', targetVersion: '1.2.4', state: 'pending' as const, lastError: null,
      } }
      f.mainStatus.mockResolvedValue(snapshot)
      const client = await f.connect('reader')
      const denied = await f.connect('scoped')
      const read = async (arguments_: Record<string, unknown>) => decodeMcpToolResult(
        await client.callTool({ name: 'computers_maintenance_status', arguments: arguments_ }),
      )
      const compact = ComputerMaintenanceOperatorListSchema.parse(await read({ target: f.main }))
      const status = compact.computers[0]!.status!
      expect(status.tasks.map(task => task.id)).toEqual([
        latest.id, recentFailure.id, latestRestart.id, longFailure.id,
      ])
      for (const summary of status.tasks) {
        expect(summary).not.toHaveProperty('outputTail')
        expect(summary.summary).toHaveLength(300)
      }
      expect(status).toMatchObject({ harnesses: snapshot.harnesses, system: snapshot.system, worker: snapshot.worker })
      const full = await read({ target: f.main, detail: 'full' })
      expect(full).toEqual({ computers: [{ target: f.main, status: snapshot }] })
      expect(await read({ target: f.main, detail: 'full', taskId: longFailure.id }))
        .toEqual({ computers: [{ target: f.main, status: { ...snapshot, tasks: [longFailure] } }] })
      expect(await read({ target: f.main, detail: 'full', taskId: randomUUID() }))
        .toMatchObject({ computers: [{ status: { tasks: [] } }] })
      expect((await client.callTool({ name: 'computers_maintenance_status',
        arguments: { target: f.main, taskId: latest.id } })).isError).toBe(true)
      for (const detail of ['compact', 'full']) {
        expect((await denied.callTool({ name: 'computers_maintenance_status',
          arguments: { target: f.main, detail } })).isError).toBe(true)
      }
      const fleet = ComputerMaintenanceOperatorListSchema.parse(await read({}))
      expect(fleet.computers[0]).toEqual(compact.computers[0])
      const http = await f.app.inject({ method: 'POST', url: '/api/management/computers/maintenance/read',
        headers: { authorization: 'Bearer reader' }, payload: { target: f.main } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(full)
    } finally { await f.close() }
  })

  it('keeps one bounded shared maintenance observation when an HTTP reader cancels', async () => {
    const f = await fixture()
    try {
      const snapshot = await f.status()
      const gate = deferred<typeof snapshot>()
      f.mainStatus.mockImplementation(() => gate.promise)
      const reads = vi.spyOn(f.maintenance, 'readTarget')
      const controller = new AbortController()
      const reading = fetch(new URL('/api/management/computers/maintenance/read', f.address), {
        method: 'POST', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
        body: JSON.stringify({ target: f.main }), signal: controller.signal,
      })
      await expect.poll(() => f.mainStatus.mock.calls.length).toBe(1)
      controller.abort()
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
      const client = await f.connect('reader')
      const second = client.callTool({ name: 'computers_maintenance_status',
        arguments: { target: f.main, refresh: true } })
      await expect.poll(() => reads.mock.calls.length).toBe(2)
      expect(f.mainStatus).toHaveBeenCalledOnce()
      expect(f.mainStatus.mock.calls[0]![0].aborted).toBe(false)
      gate.resolve(snapshot)
      expect(decodeMcpToolResult(await second)).toMatchObject({ computers: [{ target: f.main, status: snapshot }] })
    } finally { await f.close() }
  })

  it('reads one target independently through HTTP and MCP while enforcing grants and revisions', async () => {
    const f = await fixture()
    try {
      const client = await f.connect('reader')
      const denied = await f.connect('scoped')
      const gate = deferred<never>()
      f.mainAccounts.mockImplementation(() => gate.promise)
      f.mainStatus.mockImplementation(() => gate.promise)
      for (const [name, route, property] of [
        ['computer_accounts_list', 'accounts', 'accounts'],
        ['computers_maintenance_status', 'maintenance', 'status'],
      ] as const) {
        const http = await f.app.inject({ method: 'POST', url: `/api/management/computers/${route}/read`,
          headers: { authorization: 'Bearer reader' }, payload: { target: f.worker } })
        expect(http.statusCode).toBe(200)
        expect(http.json().computers).toHaveLength(1)
        expect(http.json().computers[0][property]).not.toBeNull()
        const result = await client.callTool({ name, arguments: { target: f.worker } })
        expect(result.isError).not.toBe(true)
        expect(decodeMcpToolResult(result)).toEqual(http.json())
        expect((await denied.callTool({ name, arguments: { target: f.worker } })).isError).toBe(true)
        const stale = { ...f.worker, authorizationRevision: 2 }
        expect((await client.callTool({ name, arguments: { target: stale, refresh: true } })).isError).toBe(true)
      }
      expect(f.mainAccounts).not.toHaveBeenCalled()
      expect(f.mainStatus).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(2)
      expect(f.commands.recordDenied).toHaveBeenCalledWith('scoped', 'mcp',
        'computer_accounts_list', 'mcp:computer_accounts_list')
    } finally { await f.close() }
  })

  it('rejects duplicate selectors and read-only writes, then reads a newer successful update after restart', async () => {
    const f = await fixture()
    try {
      const client = await f.connect('owner')
      const denied = await f.connect('reader')
      const input = { commandId: randomUUID(), targets: [f.main],
        task: { kind: 'update-harnesses', harnesses: ['codex'] } }
      expect((await denied.callTool({ name: 'computers_maintenance_start', arguments: input })).isError).toBe(true)
      expect((await client.callTool({ name: 'computers_maintenance_start', arguments: {
        ...input, task: { kind: 'update-harnesses', harnesses: ['codex', 'codex'] },
      } })).isError).toBe(true)
      const started = await client.callTool({ name: 'computers_maintenance_start', arguments: input })
      expect(started.isError).not.toBe(true)
      await f.drain()
      f.restart()
      const result = decodeMcpToolResult(await client.callTool({ name: 'computers_maintenance_status',
        arguments: { target: f.main, refresh: true } }))
      expect(result).toMatchObject({ computers: [{ target: f.main,
        status: { tasks: [{ id: input.commandId, state: 'succeeded', summary: 'Codex 1.2.3 → 1.2.5' }] } }] })
      const full = ComputerMaintenanceListSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'computers_maintenance_status',
        arguments: { target: f.main, detail: 'full', taskId: input.commandId },
      })))
      expect(full.computers[0]!.status!.tasks[0]).toMatchObject({
        id: input.commandId, state: 'succeeded', outputTail: expect.any(String),
      })
      const persisted = await f.status()
      expect(full.computers[0]!.status!.tasks).toEqual(persisted.tasks)
      expect(result).toMatchObject({ computers: [{ status: { tasks: [
        expect.not.objectContaining({ outputTail: expect.any(String) }),
      ] } }] })
    } finally { await f.close() }
  })

  it('skips an unsafe marketplace catalog before remote dispatch and retained output', async () => {
    const f = await fixture()
    try {
      const source = 'https://owner:fixture-password@plugins.example/repo.git'
      f.sources.codexPlugins = async () => ['docs@unsafe']
      f.sources.codexMarketplaces = async () => [{ name: 'unsafe', source }]
      const client = await f.connect('owner')
      const started = await client.callTool({ name: 'computers_maintenance_start', arguments: {
        commandId: randomUUID(), targets: [f.worker], task: { kind: 'sync-plugins' },
      } })
      expect(started.isError).not.toBe(true)
      await f.drain()
      f.restart()
      const result = decodeMcpToolResult(await client.callTool({ name: 'computers_maintenance_status',
        arguments: { target: f.worker, refresh: true } }))
      expect(JSON.stringify(f.requests)).not.toContain('fixture-password')
      expect(JSON.stringify(result)).not.toContain('fixture-password')
      expect(result).toMatchObject({ computers: [{ status: { tasks: [{ state: 'succeeded',
        summary: expect.stringContaining('Codex marketplace sources are unsafe or invalid') }] } }] })
    } finally { await f.close() }
  })

  it('refuses a replacement installation when source discovery finishes after pairing rotates', async () => {
    const f = await fixture()
    try {
      const source = deferred<Record<string, unknown>>()
      const discovering = deferred<void>()
      f.sources.codexUserMcpServers = async () => { discovering.resolve(); return source.promise }
      const client = await f.connect('owner')
      const starting = client.callTool({ name: 'computers_maintenance_start', arguments: {
        commandId: randomUUID(), targets: [f.worker], task: { kind: 'sync-mcp' },
      } })
      await discovering.promise
      f.registration.workerInstallationId = randomUUID()
      f.registration.authorizationRevision++
      source.resolve({})
      const result = decodeMcpToolResult(await starting)
      expect(result).toMatchObject({ computers: [{ target: f.worker, task: null,
        error: 'This computer is not paired with this Main.' }] })
      expect(f.requests).toEqual([])
    } finally { await f.close() }
  })
})
