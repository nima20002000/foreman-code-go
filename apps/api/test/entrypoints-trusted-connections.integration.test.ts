import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { pairingProof, publicKeyFingerprint } from '@graphql/contracts/device-identity-node'
import { TrustedConnectionApprovalReadSchema } from '@graphql/contracts/trusted-device-connection'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { buildProductionApp } from '../src/production.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

const origin = 'http://127.0.0.1:5173'
const browserHeaders = { host: '127.0.0.1:3000', origin }
const account = { email: 'entrypoints-owner@example.test', password: 'entrypoints-owned-test-password' }

async function fixture(pinOwner = true) {
  const db = await currentDatabase(), access = new PostgresAccessService(db.pool)
  const owner = await access.issue({ name: 'Existing installation owner', audience: 'operator',
    grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 3_600_000) })
  const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL!, HARNESS_WORKSPACE_ROOT: join(db.directory, 'runtime'),
    CODEX_BINARY: '/unprovisioned-test-codex', OPENCODE_BINARY: '/unprovisioned-test-opencode',
    BETTER_AUTH_SECRET: 'entrypoints-test-browser-secret-'.repeat(3), BETTER_AUTH_URL: origin,
    ...(pinOwner ? { OWNER_OPERATOR_PRINCIPAL_ID: owner.principal.id } : {}) })
  config.workspaceStorageRoot = join(db.directory, 'workspaces')
  const cpSchema = `${db.schema}_cp`
  const checkpoints = createCheckpointStore(process.env.TEST_DATABASE_URL!, cpSchema, config.database)
  const clients: Client[] = []
  let production: ReturnType<typeof buildProductionApp> | undefined
  const close = async () => {
    try { await Promise.allSettled(clients.map(client => client.close())); await production?.shutdown() }
    finally {
      await checkpoints.close()
      await db.pool.query(`drop schema if exists "${cpSchema}" cascade`)
      await db.close()
    }
  }
  try {
    await checkpoints.setup()
    const build = () => buildProductionApp(config, { pool: db.pool, ping: async () => { await db.pool.query('select 1') },
      migrate: () => applyApplicationMigrations(db.pool), close: async () => {} }, checkpoints, false)
    production = build()
    await production.initialize()
    let app = production.app, address = await app.listen({ host: '127.0.0.1', port: 0 })
    const auth = { authorization: `Bearer ${owner.token}` }
    // Pair through the original grant service and signed worker proof. Never insert an owner or consent record.
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const grant = await app.inject({ method: 'POST', url: '/api/devices/pairing-grants', headers: auth, payload: {
      workerInstallationId: randomUUID(), publicKey, expectedFingerprint: publicKeyFingerprint(publicKey),
      scopes: ['connect', 'heartbeat'], commandId: randomUUID(),
    } })
    expect(grant.statusCode, grant.body).toBe(200)
    const granted = grant.json(), pairing = { mainId: granted.registration.mainId,
      workerInstallationId: granted.registration.workerInstallationId, publicKey, grant: granted.grant, requestId: randomUUID() }
    const paired = await new PostgresDeviceAccessService(db.pool, pairing.mainId).pair({ ...pairing,
      signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') })
    const call = async (token: string) => {
      const client = new Client({ name: 'production trusted-connection readback', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const setup = async () => {
      const created = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: browserHeaders, payload: account })
      expect(created.statusCode, created.body).toBe(201)
      const signedIn = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: browserHeaders, payload: account })
      expect(signedIn.statusCode, signedIn.body).toBe(200)
      const values = signedIn.headers['set-cookie'], cookie = (Array.isArray(values) ? values : [values!]).map(value => value.split(';')[0]).join('; ')
      return { ...browserHeaders, cookie }
    }
    const restartWithOwnerPin = async () => {
      await production!.shutdown()
      config.browserAuth!.ownerPrincipalId = owner.principal.id
      production = build()
      await production.initialize()
      app = production.app
      address = await app.listen({ host: '127.0.0.1', port: 0 })
    }
    return { db, access, owner, get app() { return app }, auth, paired, setup, call, close, restartWithOwnerPin }
  } catch (error) { await close(); throw error }
}

describe.skipIf(!postgresEnabled)('trusted connections through the production Main entrypoint', () => {
  it('establishes the pinned browser owner on an existing installation without changing its paired identity or authority', async () => {
    const f = await fixture(false)
    try {
      const before = {
        principal: (await f.db.pool.query('select * from management_principals where id=$1', [f.owner.principal.id])).rows,
        installation: (await f.db.pool.query('select * from application_installation')).rows,
        main: (await f.db.pool.query('select * from device_main_identity')).rows,
        device: (await f.db.pool.query('select * from device_registrations')).rows,
      }
      const status = () => f.app.inject({ method: 'GET', url: '/api/auth/setup', headers: browserHeaders })
      expect((await status()).json()).toEqual({ state: 'locked', reason: 'existing-installation' })
      const locked = await f.app.inject({ method: 'POST', url: '/api/auth/setup', headers: browserHeaders, payload: account })
      expect(locked.statusCode).toBe(409)
      expect((await f.db.pool.query('select * from browser_auth_owner')).rows).toEqual([])
      // Same original database, Main identity, runtime and worker registration; only the supported server pin changes.
      await f.restartWithOwnerPin()
      expect((await status()).json()).toEqual({ state: 'ready' })
      const browser = await f.setup()
      expect((await status()).json()).toEqual({ state: 'complete' })
      const session = await f.app.inject({ method: 'GET', url: '/api/auth/session', headers: browser })
      expect(session.statusCode, session.body).toBe(200)
      expect(session.json().principal.id).toBe(f.owner.principal.id)
      expect(session.json().principal.grants).toEqual(f.owner.principal.grants)
      expect((await f.db.pool.query('select principal_id from browser_auth_owner where singleton=true')).rows).toEqual([{ principal_id: f.owner.principal.id }])
      expect({
        principal: (await f.db.pool.query('select * from management_principals where id=$1', [f.owner.principal.id])).rows,
        installation: (await f.db.pool.query('select * from application_installation')).rows,
        main: (await f.db.pool.query('select * from device_main_identity')).rows,
        device: (await f.db.pool.query('select * from device_registrations')).rows,
      }).toEqual(before)
      expect((await f.access.authenticate(f.owner.token)).id).toBe(f.owner.principal.id)
      const worker = await new PostgresDeviceAccessService(f.db.pool, f.paired.registration.mainId).authenticateDevice(f.paired.credential, 'connect')
      expect(worker).toMatchObject({ mainId: f.paired.registration.mainId, deviceId: f.paired.registration.deviceId,
        workerInstallationId: f.paired.registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 })
    } finally { await f.close() }
  }, 120_000)

  it('mounts HTTP/browser approval and MCP with denial, atomic consent and persisted readback', async () => {
    const f = await fixture()
    try {
      const browser = await f.setup(), deviceId = f.paired.registration.deviceId
      const read = await f.app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: f.auth, payload: { deviceId } })
      expect(read.statusCode, read.body).toBe(200)
      expect(read.json()).toEqual({ registration: f.paired.registration, consent: null })
      const checked = await f.app.inject({ method: 'POST', url: '/api/devices/connection-check', headers: f.auth, payload: { deviceId } })
      expect(checked.statusCode, checked.body).toBe(200)
      expect(checked.json().state).toBe('consent-required')
      for (const [method, url] of [['GET', '/api/devices/connection-host'], ['POST', '/api/devices/connection-inspect'],
        ['GET', '/api/devices/connection-approvals/:approvalId'], ['POST', '/api/devices/connection-approvals/:approvalId/revoke']] as const) {
        expect(f.app.hasRoute({ method, url })).toBe(true)
      }
      const client = await f.call(f.owner.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      for (const suffix of ['host_discover', 'read', 'inspect', 'check', 'configure']) expect(tools).toContain(`device_connection_${suffix}`)
      expect((await client.callTool({ name: 'device_connection_read', arguments: { deviceId } })).structuredContent).toEqual(read.json())
      const outsider = await f.access.issue({ name: 'Denied scoped caller', audience: 'operator',
        grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['another-workspace'] } }], expiresAt: new Date(Date.now() + 600_000) })
      const reader = await f.access.issue({ name: 'Read-only caller', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      expect((await f.app.inject({ method: 'POST', url: '/api/devices/connection-read',
        headers: { authorization: `Bearer ${outsider.token}` }, payload: { deviceId } })).statusCode).toBe(403)
      const deniedClient = await f.call(outsider.token), readerClient = await f.call(reader.token)
      expect((await deniedClient.callTool({ name: 'device_connection_read', arguments: { deviceId } })).isError).toBe(true)
      const input = { requestCommandId: randomUUID(), action: { deviceId, commandId: randomUUID(), expectedRevision: 0,
        expectedAuthorizationRevision: 1, endpoint: { host: '192.0.2.10', port: 22, osUser: 'test-user', transport: 'lan' },
        hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true } }
      const deniedBrowser = await f.app.inject({ method: 'POST', url: '/api/devices/connection-approvals', headers: f.auth, payload: input })
      expect(deniedBrowser.statusCode).toBe(403)
      expect(deniedBrowser.json().error.code).toBe('MCP_BROWSER_REVIEW_REQUIRED')
      const requested = await f.app.inject({ method: 'POST', url: '/api/devices/connection-approvals', headers: browser, payload: input })
      expect(requested.statusCode, requested.body).toBe(200)
      const pending = TrustedConnectionApprovalReadSchema.parse(requested.json())
      expect((await client.callTool({ name: 'device_connection_configure', arguments: pending.action })).isError).toBe(true)
      const approved = await f.app.inject({ method: 'POST', url: `/api/devices/connection-approvals/${pending.id}/approve`,
        headers: browser, payload: { commandId: randomUUID() } })
      expect(approved.statusCode, approved.body).toBe(200)
      expect((await readerClient.callTool({ name: 'device_connection_configure', arguments: pending.action })).isError).toBe(true)
      const applied = await client.callTool({ name: 'device_connection_configure', arguments: pending.action })
      expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true)
      expect(applied.structuredContent).toMatchObject({ approvedBy: f.owner.principal.id, revision: 1, automaticSudo: false, grantsAgentPermissions: false })
      expect((await client.callTool({ name: 'device_connection_configure', arguments: pending.action })).structuredContent).toEqual(applied.structuredContent)
      const persisted = await f.app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: browser, payload: { deviceId } })
      expect(persisted.statusCode, persisted.body).toBe(200)
      expect(persisted.json().consent).toEqual(applied.structuredContent)
      expect((await client.callTool({ name: 'device_connection_read', arguments: { deviceId } })).structuredContent).toEqual(persisted.json())
      const approvalRead = await f.app.inject({ method: 'GET', url: `/api/devices/connection-approvals/${pending.id}`, headers: browser })
      expect(approvalRead.statusCode, approvalRead.body).toBe(200)
      expect(approvalRead.json().state).toBe('consumed')
      const receipts = await f.db.pool.query("select result from management_command_receipts where operation='device.trusted-connection.configure' and command_id=$1", [pending.action.commandId])
      expect(receipts.rows).toEqual([{ result: applied.structuredContent }])
      const audit = await f.db.pool.query("select outcome from management_audit where action='device.trusted-connection.configure'")
      expect(audit.rows.filter(row => row.outcome === 'succeeded')).toHaveLength(1)
      expect(audit.rows.filter(row => row.outcome === 'failed')).toHaveLength(1)
      const deniedAudit = await f.db.pool.query("select outcome from management_audit where action='device_connection_configure' and principal_id=$1", [reader.principal.id])
      expect(deniedAudit.rows).toEqual([{ outcome: 'denied' }])
    } finally { await f.close() }
  }, 120_000)
})
