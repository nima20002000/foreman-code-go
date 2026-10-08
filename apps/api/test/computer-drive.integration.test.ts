import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ComputerAccountsListSchema, DriveLoginStateSchema,
  type DriveComputerRequest } from '@foreman-code/contracts/computer-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { ComputerDriveService } from '../src/modules/computers/drive.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

const token = '{"access_token":"a","refresh_token":"r"}'

describe.skipIf(!postgresEnabled)('Drive authorization through authenticated Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let mainId: string
  beforeAll(async () => {
    database = await agent3Database()
    mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  }, 60000)
  afterAll(async () => { await database?.close() })

  async function fixture() {
    const access = new PostgresAccessService(database.pool)
    const commands = new PostgresCommandCoordinator(database.pool)
    const writer = await access.issue({ name: 'Drive writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await access.issue({ name: 'Drive reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] })
    const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
    await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
    [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    const target: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId, deviceId: registration.deviceId },
      applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    // The target's storage is external I/O; authentication, registration checks and audit records use PostgreSQL.
    const credentials = new Map<string, string>()
    const requests: DriveComputerRequest[] = []
    const endpoint = {
      capabilities: () => ['computer-drive-v2', 'computer-accounts-v1'].map(namespace => ({ namespace, mainCanRequest: true })),
      request: async (device: string, namespace: string, payload: unknown) => {
        if (namespace === 'computer-accounts-v1') return { payload: { observedAt: new Date().toISOString(), accounts: [{
          tool: 'drive', installed: true, signedIn: credentials.has(device),
          account: credentials.has(device) ? 'owner@gmail.com' : null, details: [],
        }] } }
        const request = payload as DriveComputerRequest
        requests.push(request)
        if (request.operation === 'connect') credentials.set(device, request.token)
        if (request.operation === 'disconnect') credentials.delete(device)
        const connected = credentials.has(device)
        return { payload: { installed: true, connected, mounted: connected, account: connected ? 'owner@gmail.com' : null,
          mountPath: connected ? '/home/u/Foreman Code Drive' : null, message: null } }
      },
    }
    const accounts = new ComputerAccountsService(database.pool, mainId, () => endpoint, commands,
      async () => ({ observedAt: new Date().toISOString(), accounts: [] }))
    const drive = new ComputerDriveService(database.pool, mainId, () => endpoint, commands, { changed: target => accounts.invalidate(target) })
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { computerDrive: drive, computerAccounts: accounts, commands } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (bearer: string) => {
      const client = new Client({ name: 'drive-tests', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }))
      return client
    }
    const changeRegistration = async () => {
      registration.keyRevision++
      registration.authorizationRevision++
      registration.workerInstallationId = randomUUID()
      await database.pool.query('update device_registrations set worker_installation_id=$2,record=$3::jsonb where id=$1',
        [registration.deviceId, registration.workerInstallationId, JSON.stringify(registration)])
    }
    return { app, connect, writer, reader, target, credentials, requests, changeRegistration,
      close: async () => { await Promise.all(clients.map(client => client.close())); await app.close() } }
  }

  it('connects and disconnects with fresh persisted account readback, discovery, denied writes and audit records', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_drive_connect_complete')
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_drive_connect_complete')
      const readAccounts = async () => ComputerAccountsListSchema.parse((await client.callTool({
        name: 'computer_accounts_list', arguments: {},
      })).structuredContent).computers.find(entry => entry.target.applicationInstallationId === f.target.applicationInstallationId)
      expect((await readAccounts())?.accounts?.accounts[0]?.signedIn).toBe(false)
      const started = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_start',
        arguments: { target: f.target } })).structuredContent)
      const input = { target: f.target, loginId: started.loginId, token }
      expect((await reader.callTool({ name: 'computer_drive_connect_complete', arguments: input })).isError).toBe(true)
      expect(f.credentials.size).toBe(0)
      const done = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_complete', arguments: input })).structuredContent)
      expect(done.state).toBe('connected')
      expect(f.credentials.get(f.target.hostRef.kind === 'device' ? f.target.hostRef.deviceId : '')).toBe(token)
      expect((await readAccounts())?.accounts?.accounts[0]).toMatchObject({ signedIn: true, account: 'owner@gmail.com' })
      expect(DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_status',
        arguments: { target: f.target, loginId: started.loginId } })).structuredContent)).toEqual(done)
      const disconnected = await client.callTool({ name: 'computer_drive_disconnect', arguments: { target: f.target } })
      expect(DriveLoginStateSchema.parse(disconnected.structuredContent).state).toBe('disconnected')
      expect((await readAccounts())?.accounts?.accounts[0]?.signedIn).toBe(false)
      const audits = await database.pool.query<{ action: string; outcome: string }>(
        'select action,outcome from management_audit where principal_id=$1', [f.writer.principal.id])
      expect(audits.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'computer_drive_connect_complete', outcome: 'succeeded' }),
        expect.objectContaining({ action: 'computer_drive_disconnect', outcome: 'succeeded' }),
      ]))
    } finally { await f.close() }
  })

  it('cancels through authenticated MCP without allowing a read-only caller or a later token to reconnect', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const reader = await f.connect(f.reader.token)
      const started = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_start',
        arguments: { target: f.target } })).structuredContent)
      const input = { target: f.target, loginId: started.loginId }
      expect((await reader.callTool({ name: 'computer_drive_connect_cancel', arguments: input })).isError).toBe(true)
      const cancelled = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_cancel',
        arguments: input })).structuredContent)
      expect(cancelled.state).toBe('cancelled')
      expect((await client.callTool({ name: 'computer_drive_connect_complete', arguments: { ...input, token } })).isError).toBe(true)
      expect(f.credentials.size).toBe(0)
      expect(DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_status',
        arguments: input })).structuredContent)).toEqual(cancelled)
      const audits = await database.pool.query<{ outcome: string }>(
        "select outcome from management_audit where principal_id=$1 and action='computer_drive_connect_cancel'", [f.writer.principal.id])
      expect(audits.rows).toEqual([{ outcome: 'succeeded' }])
    } finally { await f.close() }
  })

  it('does not send credentials to a re-paired computer when Google authorization finishes', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const started = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_start',
        arguments: { target: f.target } })).structuredContent)
      await f.changeRegistration()
      expect((await client.callTool({ name: 'computer_drive_connect_complete',
        arguments: { target: f.target, loginId: started.loginId, token } })).isError).toBe(true)
      expect(f.credentials.size).toBe(0)
      expect(f.requests.map(request => request.operation)).toEqual(['intent', 'install'])
    } finally { await f.close() }
  })

  it('does not apply authorization after the caller loses settings access during Google sign-in', async () => {
    const f = await fixture()
    try {
      const client = await f.connect(f.writer.token)
      const started = DriveLoginStateSchema.parse((await client.callTool({ name: 'computer_drive_connect_start',
        arguments: { target: f.target } })).structuredContent)
      await database.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [f.writer.principal.id])
      expect((await client.callTool({ name: 'computer_drive_connect_complete',
        arguments: { target: f.target, loginId: started.loginId, token } })).isError).toBe(true)
      expect(f.credentials.size).toBe(0)
      expect(f.requests.map(request => request.operation)).toEqual(['intent', 'install'])
    } finally { await f.close() }
  })
})
