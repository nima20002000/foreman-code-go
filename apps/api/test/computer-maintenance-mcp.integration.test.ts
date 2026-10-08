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
import type { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
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
      codexPlugins: async () => ['pdf@openai'],
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
    expect(deviceStarts.at(-1)).toEqual({ kind: 'sync-plugins', plugins: ['pdf@openai'] })

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
})
