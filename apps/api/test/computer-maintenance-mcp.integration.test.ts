import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartResultSchema, MaintenanceRequestSchema,
  type MaintenanceStatus, type MaintenanceTaskStart,
} from '@foreman-code/contracts/computer-maintenance'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { ComputerMaintenance, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

const status = (codex: string): MaintenanceStatus => ({ observedAt: new Date().toISOString(), tasks: [],
  harnesses: [{ harness: 'codex', installed: true, version: codex, latest: '0.161.0' }, { harness: 'claude', installed: false, version: null, latest: '2.1.294' }],
  system: { packageUpdates: 3, rebootRequired: false, sudo: true, disk: { path: '/home/owner', freeBytes: 10, totalBytes: 20 } } })
const task = (start: MaintenanceTaskStart) => ({ id: randomUUID(), kind: start.kind, state: 'running' as const,
  startedAt: new Date().toISOString(), finishedAt: null, summary: 'Running…', outputTail: '' })

describe.skipIf(!postgresEnabled)('computer maintenance through Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
  })

  it('reads fleet status, starts updates and syncs Main\'s MCP servers and plugins, and denies a read-only caller', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Maintainer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const deviceStarts: MaintenanceTaskStart[] = []
    const mainStarts: MaintenanceTaskStart[] = []
    const local = { status: async () => status('0.161.0'), start: (start: MaintenanceTaskStart) => { mainStarts.push(start); return task(start) } } as unknown as ComputerMaintenance
    const commands = new PostgresCommandCoordinator(database.pool)
    const computerMaintenance = new FleetMaintenanceService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
      request: async (_deviceId, _namespace, payload) => {
        const request = MaintenanceRequestSchema.parse(payload)
        if (request.operation === 'status') return { payload: { operation: 'status', status: status('0.150.0') } }
        deviceStarts.push(request.task)
        return { payload: { operation: 'start', task: task(request.task) } }
      },
    }), commands, local, {
      codexUserMcpServers: async () => ({ linear: { url: 'https://mcp.linear.app/mcp' }, private: { command: 'x', env: { TOKEN: 'secret' } }, 'foreman-code': { command: 'app' } }),
      claudeUserMcpServers: async () => ({ docs: { type: 'http', url: 'https://docs.example/mcp' } }),
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      codexPlugins: async () => ['pdf@openai'],
      codexMarketplaces: async () => [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }],
    })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'maintenance-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const operator = await connect(writer.token)
    const listed = ComputerMaintenanceListSchema.parse((await operator.callTool({ name: 'computers_maintenance_status', arguments: { refresh: true } })).structuredContent)
    expect(listed.computers.map(computer => computer.status?.harnesses[0]?.version)).toEqual(['0.161.0', '0.150.0'])
    const http = await app.inject({ url: '/api/management/computers/maintenance', headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(ComputerMaintenanceListSchema.parse(http.json()).computers).toHaveLength(2)

    const update = { commandId: randomUUID(), task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } }
    const started = ComputerMaintenanceStartResultSchema.parse((await operator.callTool({ name: 'computers_maintenance_start', arguments: update })).structuredContent)
    expect(started.computers.map(computer => computer.task?.kind)).toEqual(['update-harnesses', 'update-harnesses'])
    // The same command never starts the work twice.
    await operator.callTool({ name: 'computers_maintenance_start', arguments: update })
    expect(mainStarts).toHaveLength(1)
    expect(deviceStarts).toHaveLength(1)

    const sync = ComputerMaintenanceStartResultSchema.parse((await operator.callTool({ name: 'computers_maintenance_start',
      arguments: { commandId: randomUUID(), task: { kind: 'sync-mcp' } } })).structuredContent)
    expect(sync.computers.map(computer => computer.target.hostRef.kind)).toEqual(['device'])
    expect(deviceStarts.at(-1)).toEqual({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: null }],
      claude: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }] } })
    await operator.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'sync-plugins' } } })
    expect(deviceStarts.at(-1)).toEqual({ kind: 'sync-plugins', plugins: ['pdf@openai'],
      marketplaces: [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }], claudePlugins: [], claudeMarketplaces: [] })

    const restartAll = await operator.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'restart' } } })
    expect(restartAll.isError).toBe(true)
    expect(JSON.stringify(restartAll.content)).toContain('COMPUTER_RESTART_TARGET_REQUIRED')

    const readOnly = await connect(reader.token)
    expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('computers_maintenance_start')
    const deniedStart = await readOnly.callTool({ name: 'computers_maintenance_start', arguments: { commandId: randomUUID(), task: { kind: 'update-system' } } })
    expect(deniedStart.isError).toBe(true)
    expect(JSON.stringify(deniedStart.content)).toContain('ACCESS_DENIED')
    expect(deviceStarts.some(start => start.kind === 'update-system')).toBe(false)
    const audits = await database.pool.query<{ source: string }>("select source from management_audit where action='computers.maintenance.start' and outcome='succeeded'")
    expect(audits.rows.length).toBeGreaterThanOrEqual(3)
    expect(new Set(audits.rows.map(row => row.source))).toEqual(new Set(['mcp']))
  })
  it('shows a running task\'s progress within seconds instead of the settled-status cache', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const owner = await new PostgresAccessService(database.pool).issue({ name: 'Progress reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const principal = await new PostgresAccessService(database.pool).authenticate(owner.token)
    const running = { ...task({ kind: 'sync-mcp', servers: { codex: [], claude: [] } }) }
    let clock = 0
    const local = { status: async () => ({ ...status('0.161.0'), tasks: [structuredClone(running)] }) } as unknown as ComputerMaintenance
    const fleet = new FleetMaintenanceService(database.pool, mainId, () => undefined, new PostgresCommandCoordinator(database.pool), local,
      { codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}), claudePlugins: async () => ({ plugins: [], marketplaces: [] }), codexPlugins: async () => [], codexMarketplaces: async () => [] }, () => clock)
    const main = async () => (await fleet.list(principal)).computers.find(computer => computer.target.hostRef.kind === 'main')!.status!.tasks[0]!
    expect(await main()).toMatchObject({ state: 'running' })
    Object.assign(running, { state: 'succeeded', summary: 'Codex: Added linear', finishedAt: new Date().toISOString() })
    clock = 4_000
    expect(await main()).toMatchObject({ state: 'succeeded', summary: 'Codex: Added linear' })
    Object.assign(running, { summary: 'changed after settling' })
    clock = 8_000
    expect(await main()).toMatchObject({ summary: 'Codex: Added linear' })
  })
  it('keeps harness updates and MCP sync working when plugin discovery fails', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const starts: MaintenanceTaskStart[] = []
    const local = {
      status: async () => status('0.150.0'),
      start: (input: MaintenanceTaskStart) => { starts.push(input); return task(input) },
    } as unknown as ComputerMaintenance
    const service = new FleetMaintenanceService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
      request: async (_deviceId, _namespace, payload) => {
        const request = MaintenanceRequestSchema.parse(payload)
        if (request.operation === 'status') return { payload: { operation: 'status', status: status('0.150.0') } }
        starts.push(request.task)
        return { payload: { operation: 'start', task: task(request.task) } }
      },
    }), new PostgresCommandCoordinator(database.pool), local, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => { throw new Error('Codex plugin catalog unavailable') },
      codexMarketplaces: async () => [], claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    })
    await expect(service.keepCurrent()).rejects.toThrow('Some fleet settings could not be read.')
    expect(starts.map(input => input.kind)).toEqual(expect.arrayContaining(['update-harnesses', 'sync-mcp']))
    expect(starts.some(input => input.kind === 'sync-plugins')).toBe(false)
  })

  it('verifies OS updates through MCP and returns phased packages as pending', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(database.pool)
    const owner = await access.issue({ name: 'OS update verifier', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    let upgraded = false
    let readbacks = 0
    const ports: MaintenancePorts = {
      environment: { HOME: '/home/owner' }, find: async name => name === 'apt-get' ? '/usr/bin/apt-get' : null,
      run: async (binary, args) => {
        if (binary.endsWith('apt-get')) {
          if (upgraded) readbacks++
          return { code: 0, stdout: `${upgraded ? 0 : 2} upgraded, 0 newly installed, 0 to remove and 23 not upgraded.`, stderr: '' }
        }
        if (args.includes('upgrade')) upgraded = true
        return { code: 0, stdout: '2 upgraded, 0 newly installed, 0 to remove and 23 not upgraded.', stderr: '' }
      },
      exists: async () => false, readText: async () => null, writePrivateText: async () => undefined, disk: async () => null,
      later: () => {}, now: () => new Date(),
    }
    const commands = new PostgresCommandCoordinator(database.pool)
    const service = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands,
      new ComputerMaintenance(ports), {
        codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
        codexPlugins: async () => [], codexMarketplaces: async () => [],
        claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
      })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerMaintenance: service, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'update-readback-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${owner.token}` } },
    }))
    const before = ComputerMaintenanceListSchema.parse((await client.callTool({ name: 'computers_maintenance_status',
      arguments: { refresh: true } })).structuredContent)
    const main = before.computers.find(computer => computer.target.hostRef.kind === 'main')!
    expect(main.status?.system.packageUpdates).toBe(25)
    const started = await client.callTool({ name: 'computers_maintenance_start', arguments: {
      commandId: randomUUID(), task: { kind: 'update-system' }, targets: [main.target],
    } })
    expect(started.isError).not.toBe(true)
    await expect.poll(async () => {
      const current = ComputerMaintenanceListSchema.parse((await client.callTool({ name: 'computers_maintenance_status',
        arguments: { refresh: true } })).structuredContent).computers.find(computer => computer.target.hostRef.kind === 'main')
      return current?.status?.tasks[0]?.state
    }).toBe('succeeded')
    const after = ComputerMaintenanceListSchema.parse((await client.callTool({ name: 'computers_maintenance_status',
      arguments: { refresh: true } })).structuredContent).computers.find(computer => computer.target.hostRef.kind === 'main')!
    expect(after.status?.system.packageUpdates).toBe(23)
    expect(after.status?.tasks[0]?.summary).toContain('23 updates pending')
    expect(readbacks).toBeGreaterThan(0)
  })

})
