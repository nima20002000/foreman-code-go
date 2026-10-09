import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requirePrincipal } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresTrustedConnectionHumanAuthority, registerTrustedConnectionApprovalRoutes } from '../src/modules/devices/trustedConnectionHumanAuthority.js'
import { PostgresTrustedConnectionSetup } from '../src/modules/devices/trustedConnectionSetup.js'
import { registerTrustedConnectionRoutes } from '../src/modules/devices/trustedConnectionManagement.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { TrustedConnectionApprovalReadSchema } from '@foreman-code/contracts/trusted-device-connection'

const url = process.env.TEST_DATABASE_URL
const grants: ManagementGrant[] = [{ actions: ['settings:read', 'settings:update'], scope: {} }]
const origin = 'http://127.0.0.1:5173'
const browser = { host: '127.0.0.1:3000', origin }
/** Real PostgreSQL, production local-demo browser authentication and authenticated /mcp.
 * No live installation, network command, new agent grant or native qualification is changed. */
describe.skipIf(!url)('trusted connection action approval and delegated MCP application (PostgreSQL)', () => {
  let admin: pg.Pool, pool: pg.Pool, access: PostgresAccessService, app: ReturnType<typeof buildApp>, address: string
  let owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  const schema = `connection_approval_${randomUUID().replaceAll('-', '')}`, mainId = randomUUID(), clients: Client[] = []
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || !parsed.pathname.includes('test')) throw new Error('Explicit owned loopback test database required.')
    admin = new pg.Pool({ connectionString: url }); await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    access = new PostgresAccessService(pool)
    owner = await access.issue({ name: 'Owned test human', audience: 'operator', grants, expiresAt: new Date(Date.now() + 3_600_000) })
    await pool.query('update local_human_principal set principal_id=$1', [owner.principal.id])
    const authority = new PostgresTrustedConnectionHumanAuthority(pool, mainId)
    const setup = new PostgresTrustedConnectionSetup(pool, mainId, { verifyOwnerApproval: authority.verifyOwnerApproval })
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      localHuman: { current: () => access.currentOperator(owner.principal.id) }, browserOrigin: origin,
      operator: { access, services: { commands: new PostgresCommandCoordinator(pool), trustedConnections: setup } as unknown as OperatorServices } })
    registerTrustedConnectionApprovalRoutes(app, authority)
    registerTrustedConnectionRoutes(app, setup, async request => request.reauthorizeOperator ? request.reauthorizeOperator() : requirePrincipal(request))
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await pool?.end()
    if (admin) { await dropFixtureSchema(admin, schema); await admin.end() }
  })
  async function delegate(actions = grants) {
    const issued = await access.issue({ name: 'Owned test Operator', audience: 'operator', grants: actions, expiresAt: new Date(Date.now() + 3_600_000) })
    const conversationId = randomUUID(), operatorId = randomUUID(), configurationId = randomUUID()
    await pool.query("insert into application_operators(id,current_configuration_version_id,record) values($1,$2,'{}')", [operatorId, configurationId])
    await pool.query("insert into operator_configuration_versions(id,operator_id,version,record) values($1,$2,1,'{}')", [configurationId, operatorId])
    await pool.query("insert into operator_conversations(id,kind,operator_id,operator_configuration_version_id,owner_principal_id,harness,record) values($1,'operator',$2,$3,$4,'codex','{\"status\":\"open\"}')", [conversationId, operatorId, configurationId, owner.principal.id])
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, owner.principal.id])
    await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, conversationId])
    return { ...issued, conversationId }
  }
  async function fixture() {
    const deviceId = randomUUID(), registration = { mainId, deviceId, workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'], status: 'paired' }
    await pool.query("insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'owned SQL fixture public key',$4::jsonb)", [deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    const input = { requestCommandId: randomUUID(), action: { deviceId, commandId: randomUUID(), expectedRevision: 0,
      expectedAuthorizationRevision: 1, endpoint: { host: '192.0.2.10', port: 22, osUser: 'test-user', transport: 'lan' as const },
      hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true } }
    return { deviceId, input }
  }
  async function request(input: unknown) {
    const response = await app.inject({ method: 'POST', url: '/api/devices/connection-approvals', headers: browser, payload: input as Record<string, unknown> })
    expect(response.statusCode, response.body).toBe(200)
    return TrustedConnectionApprovalReadSchema.parse(response.json())
  }
  async function approve(id: string) {
    const response = await app.inject({ method: 'POST', url: `/api/devices/connection-approvals/${id}/approve`, headers: browser, payload: { commandId: randomUUID() } })
    expect(response.statusCode, response.body).toBe(200); return TrustedConnectionApprovalReadSchema.parse(response.json())
  }
  async function client(token: string) {
    const c = new Client({ name: 'connection-sql-acceptance', version: '1' }); clients.push(c)
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    return c
  }
  const count = async (id: string, operation: string) => (await pool.query('select count(*)::int as count from management_command_receipts where operation=$1 and target_key=$2', [operation, `${mainId}:${id}`])).rows[0].count
  it('retains exact browser decision and commits one delegated application, retry, audit and HTTP/MCP readback', async () => {
    const d = await delegate(), f = await fixture(), input = { ...f.input, applyPrincipalId: d.principal.id }
    const pending = await request(input); expect(await request(input)).toEqual(pending)
    expect(pending.applyAuthority).toMatchObject({ principalId: d.principal.id, delegatedFromOwnerId: owner.principal.id, conversationId: d.conversationId })
    const c = await client(d.token)
    expect((await c.callTool({ name: 'device_connection_configure', arguments: pending.action })).isError).toBe(true)
    await approve(pending.id)
    const applied = await c.callTool({ name: 'device_connection_configure', arguments: pending.action })
    expect(applied.isError).not.toBe(true); expect(decodeMcpToolResult(applied)).toMatchObject({ revision: 1, approvedBy: owner.principal.id, grantsAgentPermissions: false, automaticSudo: false })
    expect(decodeMcpToolResult((await c.callTool({ name: 'device_connection_configure', arguments: pending.action })))).toEqual(decodeMcpToolResult(applied))
    expect(await count(pending.id, 'device.trusted-connection.approval.consume')).toBe(1)
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(1)
    const audit = await pool.query("select source,outcome from management_audit where principal_id=$1 and action='device.trusted-connection.configure' and outcome='succeeded'", [d.principal.id])
    expect(audit.rows).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
    const http = await app.inject({ method: 'POST', url: '/api/devices/connection-read', headers: browser, payload: { deviceId: f.deviceId } })
    expect(http.statusCode).toBe(200); expect(http.json().consent).toEqual(decodeMcpToolResult(applied))
    expect(decodeMcpToolResult((await c.callTool({ name: 'device_connection_read', arguments: { deviceId: f.deviceId } })))).toEqual(http.json())
    const persisted = await app.inject({ method: 'GET', url: `/api/devices/connection-approvals/${pending.id}`, headers: browser })
    expect(persisted.json().state).toBe('consumed')
    expect((await c.callTool({ name: 'device_connection_configure', arguments: { ...pending.action, commandId: randomUUID(), expectedRevision: 1 } })).isError).toBe(true)
    expect(await count(pending.id, 'device.trusted-connection.approval.consume')).toBe(1)
  })
  it('keeps omitted delegate owner-only; denies wrong applier and bearer-only human approval', async () => {
    const d = await delegate(), wrong = await delegate(), f = await fixture()
    const ownerOnly = await request(f.input); await approve(ownerOnly.id)
    const c = await client(d.token)
    expect((await c.callTool({ name: 'device_connection_configure', arguments: ownerOnly.action })).isError).toBe(true)
    const bound = await request({ ...f.input, requestCommandId: randomUUID(), applyPrincipalId: d.principal.id }); await approve(bound.id)
    expect((await (await client(wrong.token)).callTool({ name: 'device_connection_configure', arguments: bound.action })).isError).toBe(true)
    expect(await count(bound.id, 'device.trusted-connection.approval.consume')).toBe(0)
    const bearerApproval = await app.inject({ method: 'POST', url: '/api/devices/connection-approvals', headers: { authorization: `Bearer ${owner.token}` }, payload: f.input })
    expect(bearerApproval.statusCode).toBe(403); expect(bearerApproval.json().error.code).toBe('MCP_BROWSER_REVIEW_REQUIRED')
  })
  it('denies a read-only MCP caller and persists denial audit without changing consent', async () => {
    const f = await fixture(), readOnly = await delegate([{ actions: ['settings:read'], scope: {} }]), pending = await request(f.input)
    await approve(pending.id)
    const c = await client(readOnly.token), denied = await c.callTool({ name: 'device_connection_configure', arguments: pending.action })
    expect(denied.isError).toBe(true); expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(0)
    expect((await pool.query("select count(*)::int as count from management_audit where principal_id=$1 and action='device_connection_configure' and outcome='denied'", [readOnly.principal.id])).rows[0].count).toBe(1)
  })
  it.each(['grants', 'revoked', 'expired', 'closed'] as const)('denies the approved delegate after %s change', async change => {
    const d = await delegate(), f = await fixture(), pending = await request({ ...f.input, applyPrincipalId: d.principal.id }); await approve(pending.id)
    const c = await client(d.token)
    if (change === 'grants') await pool.query("update management_principals set grants='[]' where id=$1", [d.principal.id])
    if (change === 'revoked') await access.revoke(d.principal.id)
    if (change === 'expired') await pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [d.principal.id])
    if (change === 'closed') await pool.query("update operator_conversations set record=jsonb_set(record,'{status}','\"closed\"') where id=$1", [d.conversationId])
    try { expect((await c.callTool({ name: 'device_connection_configure', arguments: pending.action })).isError).toBe(true) }
    catch (error) { expect(String(error)).toMatch(/401|403|revoked|expired|Unauthorized/i) }
    expect(await count(pending.id, 'device.trusted-connection.approval.consume')).toBe(0)
    expect(await count(f.deviceId, 'device.trusted-connection.configure')).toBe(0)
  })
  it('rejects an expired action approval while leaving original receipts intact', async () => {
    const d = await delegate(), f = await fixture(), pending = await request({ ...f.input, applyPrincipalId: d.principal.id }); await approve(pending.id)
    const c = await client(d.token), clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.expiresAt) + 1)
    try { expect((await c.callTool({ name: 'device_connection_configure', arguments: pending.action })).isError).toBe(true) } finally { clock.mockRestore() }
    expect(await count(pending.id, 'device.trusted-connection.approval.consume')).toBe(0)
    expect((await request({ ...f.input, applyPrincipalId: d.principal.id })).expiresAt).toBe(pending.expiresAt)
  })
})
