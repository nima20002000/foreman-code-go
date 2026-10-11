import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { registerTrustedConnectionTools } from './trustedConnectionManagement.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { describe, expect, it, vi } from 'vitest'
import { PostgresTrustedConnectionHumanAuthority, registerTrustedConnectionApprovalRoutes } from './trustedConnectionHumanAuthority.js'
import { PostgresTrustedConnectionSetup } from './trustedConnectionSetup.js'
interface Receipt { principal_id: string; operation: string; command_id: string; target_key: string; input_hash: string; result: unknown }
function fixture(options: { ownerConfigured?: boolean } = {}) {
  const mainId = randomUUID(), deviceId = randomUUID()
  let registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect'], status: 'paired' }
  const principal: ManagementPrincipal = { id: 'human-owner', name: 'Owner', audience: 'operator', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const delegate = { ...principal, id: 'operator-delegate' }
  let delegateRevoked = false, delegateGrants = structuredClone(delegate.grants), chatOpen = true, delegateExpiry = new Date(principal.expiresAt)
  const conversationId = randomUUID()
  let ownerId: string | null = options.ownerConfigured === false ? null : principal.id
  let principalRevoked = false, failConsentInsert = false
  let receipts: Receipt[] = [], backup: Receipt[] | null = null
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = []
    if (sql === 'begin') backup = structuredClone(receipts)
    else if (sql === 'commit') backup = null
    else if (sql === 'rollback') { if (backup) receipts = backup; backup = null }
    else if (sql.includes('select id,name,audience,grants')) rows = [{ ...principal, id: values[0], grants: values[0] === delegate.id ? delegateGrants : principal.grants, expires_at: values[0] === delegate.id ? delegateExpiry : new Date(principal.expiresAt), revoked_at: principalRevoked || values[0] === delegate.id && delegateRevoked ? new Date() : null, delegated_from: values[0] === delegate.id ? principal.id : null }]
    else if (sql.includes('operator_chat_credentials')) rows = values[0] === delegate.id ? [{ conversation_id: conversationId, owner_principal_id: principal.id, deleted_at: null, status: chatOpen ? 'open' : 'closed' }] : []
    else if (sql.includes('select audience,delegated_from')) rows = [{ audience: 'operator', delegated_from: values[0] === delegate.id ? principal.id : null }]
    else if (sql.includes('from local_human_principal')) rows = ownerId ? [{ principal_id: ownerId }] : []
    else if (sql.includes('from device_registrations')) rows = [{ record: registration }]
    else if (sql.includes('select input_hash, target_key, result')) rows = receipts.filter(row => row.principal_id === values[0] && row.operation === values[1] && row.command_id === values[2])
    else if (sql.includes("result->>'id'=$2")) rows = receipts.filter(row => row.operation === values[0] && (row.result as { id?: string }).id === values[1] && (row.result as { mainId?: string }).mainId === values[2])
    else if (sql.includes('select operation,result')) rows = receipts.filter(row => row.target_key === values[0] && (values[1] as string[]).includes(row.operation))
    else if (sql.includes("order by (result->>'revision')")) rows = receipts.filter(row => row.operation === values[0] && row.target_key === values[1]).sort((a, b) => (b.result as { revision: number }).revision - (a.result as { revision: number }).revision).slice(0, 1)
    else if (sql.includes('select result from management_command_receipts')) rows = receipts.filter(row => row.operation === values[0] && row.target_key === values[1])
    else if (sql.includes('insert into management_command_receipts')) {
      if (failConsentInsert && values[1] === 'device.trusted-connection.configure') throw new Error('CONSENT_WRITE_FAILED')
      receipts.push({ principal_id: String(values[0]), operation: String(values[1]), command_id: String(values[2]), target_key: String(values[3]), input_hash: String(values[4]), result: JSON.parse(values[5] as string) })
    }
    return { rows, rowCount: rows.length, fields: [], command: 'SELECT', oid: 0 }
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { query, connect: async () => client } as unknown as pg.Pool
  const request = { operatorPrincipal: principal, operatorAuthentication: 'local-human' } as FastifyRequest
  const authority = new PostgresTrustedConnectionHumanAuthority(pool, mainId)
  const setup = new PostgresTrustedConnectionSetup(pool, mainId, { verifyOwnerApproval: authority.verifyOwnerApproval })
  const input = { requestCommandId: randomUUID(), action: { deviceId, commandId: randomUUID(), expectedRevision: 0, expectedAuthorizationRevision: 1, endpoint: { host: '100.64.0.20', port: 22, osUser: 'builder', transport: 'tailscale' as const }, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true } }
  return { authority, setup, principal, delegate, request, input, query, client, revokeDelegate: () => { delegateRevoked = true }, removeDelegateGrant: () => { delegateGrants = [] }, changeDelegateGrant: () => { delegateGrants = [{ actions: ['settings:update'], scope: {} }] }, expireDelegate: () => { delegateExpiry = new Date(Date.now() - 1000) }, closeChat: () => { chatOpen = false }, get receipts() { return receipts }, updateDevice: (change: Partial<DeviceRegistration>) => { registration = { ...registration, ...change } }, switchOwner: () => { ownerId = 'replacement-owner' }, revokePrincipal: () => { principalRevoked = true }, failWrite: (value: boolean) => { failConsentInsert = value } }
}
describe('connection-specific human owner approval authority', () => {
  it('allows the implicit local human to approve and persist connection consent', async () => {
    const f = fixture()
    const pending = await f.authority.requestBrowser(f.request, f.input)
    const approved = await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    const consent = await f.setup.configure(f.principal, approved.action)
    expect(consent).toMatchObject({ approvedBy: f.principal.id, endpoint: f.input.action.endpoint })
    expect((await f.authority.readBrowser(f.request, pending.id)).state).toBe('consumed')
  })

  it('does not turn local human access into bearer approval or replace an established owner', async () => {
    const f = fixture()
    await expect(f.authority.requestBrowser({ ...f.request, operatorAuthentication: 'bearer' } as FastifyRequest, f.input))
      .rejects.toMatchObject({ code: 'MCP_BROWSER_REVIEW_REQUIRED' })
    f.switchOwner()
    await expect(f.authority.requestBrowser(f.request, f.input)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
    const unconfigured = fixture({ ownerConfigured: false })
    await expect(unconfigured.authority.requestBrowser(unconfigured.request, unconfigured.input))
      .rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
  })

  it('revalidates local human permissions before consuming approval', async () => {
    const f = fixture()
    const pending = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    f.revokePrincipal()
    await expect(f.setup.configure(f.principal, pending.action)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('issues truthful pending exact action, preserves request identity/expiry, approves and atomically consumes', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    expect(pending.state).toBe('pending'); expect(pending.action).toEqual({ ...f.input.action, approvalId: pending.id })
    expect(await f.authority.requestBrowser(f.request, f.input)).toEqual(pending)
    await expect(f.setup.configure(f.principal, pending.action)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED' })
    const approved = await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    expect(approved.state).toBe('approved')
    const consent = await f.setup.configure(f.principal, pending.action, 'mcp')
    expect(consent.approvedBy).toBe(f.principal.id); expect(consent.grantsAgentPermissions).toBe(false)
    expect((await f.authority.readBrowser(f.request, pending.id)).state).toBe('consumed')
    expect(await f.setup.configure(f.principal, pending.action, 'http')).toEqual(consent)
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(1)
    await expect(f.authority.verifyOwnerApproval(f.client, f.principal, pending.action, pending.registration)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED' })
  })
  it('applies an exact human-approved connection action through its explicitly bound Operator MCP delegate', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, { ...f.input, applyPrincipalId: f.delegate.id })
    expect(pending.applyAuthority).toMatchObject({ principalId: f.delegate.id, audience: 'operator', delegatedFromOwnerId: f.principal.id })
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    const server = new McpServer({ name: 'bound-connection-delegate', version: '1' }), client = new Client({ name: 'delegate', version: '1' })
    registerTrustedConnectionTools(server, f.setup, f.delegate)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      const result = await client.callTool({ name: 'device_connection_configure', arguments: pending.action })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ approvedBy: f.principal.id, grantsAgentPermissions: false })
      const retry = await client.callTool({ name: 'device_connection_configure', arguments: pending.action })
      expect(retry.structuredContent).toEqual(result.structuredContent)
      expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(1)
      await expect(f.authority.verifyOwnerApproval(f.client, f.delegate, pending.action, pending.registration)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED' })
      const readback = await client.callTool({ name: 'device_connection_read', arguments: { deviceId: f.input.action.deviceId } })
      expect(readback.structuredContent).toMatchObject({ consent: result.structuredContent })
    } finally { await client.close(); await server.close() }
  })
  it('keeps the authority binding stable as time passes without changed grants or expiry facts', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, { ...f.input, applyPrincipalId: f.delegate.id })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    try {
      const approved = await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
      expect(approved.applyAuthority?.authorityHash).toBe(pending.applyAuthority?.authorityHash)
      expect((await f.setup.configure(f.delegate, approved.action, 'mcp')).approvedBy).toBe(f.principal.id)
    } finally { clock.mockRestore() }
  })
  it('keeps omitted delegate approvals owner-only and denies wrong delegate, owner substitution and wrong action', async () => {
    const f = fixture(), ownerOnly = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, ownerOnly.id, { commandId: randomUUID() }, 'approve')
    await expect(f.setup.configure(f.delegate, ownerOnly.action, 'mcp')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
    const bound = await f.authority.requestBrowser(f.request, { ...f.input, requestCommandId: randomUUID(), applyPrincipalId: f.delegate.id })
    await f.authority.decideBrowser(f.request, bound.id, { commandId: randomUUID() }, 'approve')
    await expect(f.setup.configure({ ...f.delegate, id: 'other-agent' }, bound.action, 'mcp')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_APPLIER' })
    await expect(f.setup.configure(f.principal, bound.action)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_APPLIER' })
    await expect(f.setup.configure(f.delegate, { ...bound.action, endpoint: { ...bound.action.endpoint, osUser: 'root' } }, 'mcp')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_APPROVAL_MISMATCH' })
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(0)
  })
  it.each(['changed', 'removed', 'revoked', 'expired', 'closed', 'stale-device'])('denies bound delegate after %s authority change', async change => {
    const f = fixture(), bound = await f.authority.requestBrowser(f.request, { ...f.input, applyPrincipalId: f.delegate.id })
    await f.authority.decideBrowser(f.request, bound.id, { commandId: randomUUID() }, 'approve')
    if (change === 'changed') f.changeDelegateGrant()
    if (change === 'removed') f.removeDelegateGrant()
    if (change === 'revoked') f.revokeDelegate()
    if (change === 'expired') f.expireDelegate()
    if (change === 'closed') f.closeChat()
    if (change === 'stale-device') f.updateDevice({ keyRevision: 2 })
    await expect(f.setup.configure(f.delegate, bound.action, 'mcp')).rejects.toMatchObject({ code: change === 'changed' ? 'DEVICE_CONNECTION_DELEGATE_CHANGED' : change === 'removed' ? 'ACCESS_DENIED' : change === 'revoked' || change === 'expired' ? 'AUTH_REVOKED' : change === 'closed' ? 'DEVICE_CONNECTION_DELEGATE_UNAVAILABLE' : 'DEVICE_CONNECTION_APPROVAL_MISMATCH' })
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(0)
  })
  it('does not bind an ineligible delegate, and requires unchanged authority at human review', async () => {
    const f = fixture(); f.removeDelegateGrant()
    await expect(f.authority.requestBrowser(f.request, { ...f.input, applyPrincipalId: f.delegate.id })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const eligible = fixture(), pending = await eligible.authority.requestBrowser(eligible.request, { ...eligible.input, applyPrincipalId: eligible.delegate.id })
    eligible.changeDelegateGrant()
    expect((await eligible.authority.readBrowser(eligible.request, pending.id)).state).toBe('stale')
    await expect(eligible.authority.decideBrowser(eligible.request, pending.id, { commandId: randomUUID() }, 'approve')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_APPROVAL_NOT_PENDING' })
  })
  it('rejects bearer authentication even with human principal, and arbitrary/missing approval IDs', async () => {
    const f = fixture()
    await expect(f.authority.requestBrowser({ ...f.request, operatorAuthentication: 'bearer' } as FastifyRequest, f.input)).rejects.toMatchObject({ code: 'MCP_BROWSER_REVIEW_REQUIRED' })
    await expect(f.setup.configure(f.principal, { ...f.input.action, approvalId: randomUUID() })).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_APPROVAL_NOT_FOUND' })
    expect(f.receipts).toHaveLength(0)
  })
  it('does not treat agent settings grants, another owner or revoked authority as approval', async () => {
    const f = fixture(), agent = { ...f.principal, id: 'agent' }
    await expect(f.authority.requestBrowser({ ...f.request, operatorPrincipal: agent } as FastifyRequest, f.input)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
    const pending = await f.authority.requestBrowser(f.request, f.input)
    f.switchOwner()
    await expect(f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
    f.revokePrincipal()
    await expect(f.authority.readBrowser(f.request, pending.id)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })
  it.each([
    { keyRevision: 2 }, { authorizationRevision: 2 }, { status: 'revoked' as const }, { workerInstallationId: randomUUID() },
  ])('fences approval after device change %j', async change => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    f.updateDevice(change)
    const read = await f.authority.readBrowser(f.request, pending.id)
    expect(read.state).toBe(change.status === 'revoked' ? 'revoked' : 'stale')
    await expect(f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_APPROVAL_NOT_PENDING' })
  })
  it.each(['osUser', 'host', 'hostKey', 'allow', 'command', 'revision'])('denies reuse for a changed %s', async field => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    const action = structuredClone(pending.action)
    if (field === 'osUser') action.endpoint.osUser = 'root'
    if (field === 'host') action.endpoint.host = 'other.example'
    if (field === 'hostKey') action.hostKeyFingerprint = `SHA256:${'c'.repeat(43)}`
    if (field === 'allow') action.allowOwnerCommands = false
    if (field === 'command') action.commandId = randomUUID()
    if (field === 'revision') action.expectedRevision = 1
    await expect(f.setup.configure(f.principal, action)).rejects.toMatchObject({ code: field === 'revision' ? 'DEVICE_CONNECTION_CONFLICT' : 'DEVICE_CONNECTION_APPROVAL_MISMATCH' })
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(0)
  })
  it('expiration never extends on retry and prevents approval/consumption', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.expiresAt) + 1)
    try {
      expect((await f.authority.requestBrowser(f.request, f.input)).state).toBe('expired')
      await expect(f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_APPROVAL_NOT_PENDING' })
    } finally { clock.mockRestore() }
  })
  it('rejects an expired approved receipt and an agent attempting to consume human authority', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    await expect(f.setup.configure({ ...f.principal, id: 'agent' }, pending.action)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_WRONG_OWNER' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.expiresAt) + 1)
    try { await expect(f.setup.configure(f.principal, pending.action)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED' }) }
    finally { clock.mockRestore() }
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(0)
  })
  it('owner revocation of a pending or approved receipt prevents later configuration', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    const command = { commandId: randomUUID() }
    expect((await f.authority.decideBrowser(f.request, pending.id, command, 'revoke')).state).toBe('revoked')
    expect((await f.authority.decideBrowser(f.request, pending.id, command, 'revoke')).state).toBe('revoked')
    await expect(f.setup.configure(f.principal, pending.action)).rejects.toMatchObject({ code: 'DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED' })
  })
  it('rolls consumption back with a failed consent write, then permits the exact retry', async () => {
    const f = fixture(), pending = await f.authority.requestBrowser(f.request, f.input)
    await f.authority.decideBrowser(f.request, pending.id, { commandId: randomUUID() }, 'approve')
    f.failWrite(true)
    await expect(f.setup.configure(f.principal, pending.action)).rejects.toThrow('CONSENT_WRITE_FAILED')
    expect((await f.authority.readBrowser(f.request, pending.id)).state).toBe('approved')
    expect(f.receipts.filter(row => row.operation.endsWith('.consume'))).toHaveLength(0)
    f.failWrite(false)
    await f.setup.configure(f.principal, pending.action)
    expect((await f.authority.readBrowser(f.request, pending.id)).state).toBe('consumed')
  })
  it('binds human review through browser routes and denies bearer approval without any live security change', async () => {
    const f = fixture(), app = Fastify()
    app.addHook('preHandler', async request => { request.operatorPrincipal = f.principal; request.operatorAuthentication = request.headers.authorization ? 'bearer' : 'local-human' })
    registerTrustedConnectionApprovalRoutes(app, f.authority)
    try {
      const pending = await app.inject({ method: 'POST', url: '/api/devices/connection-approvals', payload: f.input })
      expect(pending.statusCode).toBe(200)
      const id = pending.json().id as string
      const denied = await app.inject({ method: 'POST', url: `/api/devices/connection-approvals/${id}/approve`, headers: { authorization: 'Bearer owner' }, payload: { commandId: randomUUID() } })
      expect(denied.statusCode).toBe(403)
      const approved = await app.inject({ method: 'POST', url: `/api/devices/connection-approvals/${id}/approve`, payload: { commandId: randomUUID() } })
      expect(approved.statusCode).toBe(200); expect(approved.json().state).toBe('approved')
    } finally { await app.close() }
  })
})
