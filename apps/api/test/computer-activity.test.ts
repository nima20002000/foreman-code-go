import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { BuildComputerStatusSchema } from '@foreman-code/contracts/build-computers'
import { ComputerActivityListSchema, COMPUTER_ACTIVITY_LIMIT } from '@foreman-code/contracts/computer-activity'
import type { DevicePresence } from '@foreman-code/contracts/device-connection'
import { buildApp } from '../src/app.js'
import { DomainError } from '../src/modules/errors.js'
import { BuildComputerSettings } from '../src/modules/settings/buildComputers.js'
import { ComputerActivityService } from '../src/modules/computers/activity.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const workerId = '33333333-3333-4333-8333-333333333333'
const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }
const denied: ManagementPrincipal = { ...owner, id: 'denied', grants: [{ actions: ['jobs:read'], scope: {} }] }
const settingsReader: ManagementPrincipal = { ...owner, id: 'settings-reader', grants: [{ actions: ['settings:read'], scope: {} }] }
const scoped: ManagementPrincipal = { ...owner, id: 'scoped', grants: [
  { actions: ['settings:read'], scope: {} }, { actions: ['jobs:read', 'runs:read'], scope: { workspaceIds: ['allowed'] } },
] }
const target = { hostRef: { kind: 'device' as const, mainId, deviceId }, applicationInstallationId: workerId,
  keyRevision: 1, authorizationRevision: 1 }
const registration = { mainId, deviceId, workerInstallationId: workerId, keyRevision: 1, authorizationRevision: 1,
  status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
const job = (id: string, workspaceId: string) => ({ target, activity: { id, name: `Job ${id}`, workspaceId,
  workspaceName: workspaceId, phase: 'running', startedAt: '2026-10-06T00:00:00Z' } })
const agent = (id: string, workspaceId: string) => ({ target, activity: { id, workspaceId, workflowId: 'workflow',
  workflowName: 'Website', runId: 'run', nodeId: 'review', agentName: 'Reviewer', state: 'waiting' } })

async function fixture() {
  const pool = new pg.Pool()
  const jobs = [job('visible', 'allowed'), job('secret', 'private')]
  const agents = [agent('visible', 'allowed'), agent('secret', 'private')]
  let observed: DevicePresence | null = { binding: { mainId, deviceId, workerInstallationId: workerId,
    keyRevision: 1, authorizationRevision: 1, bootId: '44444444-4444-4444-8444-444444444444',
    connectionGeneration: 1, connectionEpoch: '55555555-5555-4555-8555-555555555555' },
  phase: 'ready', dispatch: true, transfer: true, appVersion: '1', protocolVersion: 1,
  lastSeenAt: '2026-10-06T00:00:00Z' }
  let preference = { target, revision: '0', build_enabled: false, build_priority: 50,
    build_role: 'primary', build_allowance_percent: 100 }
  const receipts = new Map<string, { input_hash: unknown; target_key: unknown; result: unknown }>()
  const principals = new Map([owner, denied, scoped, settingsReader].map(principal => [principal.id, principal]))
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes('from management_principals')) {
      const principal = principals.get(String(values[0]))!
      return { rows: [{ id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
        expires_at: new Date(principal.expiresAt), revoked_at: principal.revokedAt, delegated_from: null }] }
    }
    if (text.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (text.includes('from build_computer_preferences')) return { rows: [preference] }
    if (text.includes('insert into build_computer_preferences')) {
      preference = { target: JSON.parse(String(values[1])), revision: String(values[2]), build_enabled: Boolean(values[3]),
        build_priority: Number(values[4]), build_role: String(values[5]), build_allowance_percent: Number(values[6]) }
    }
    if (text.includes('from management_command_receipts')) {
      const receipt = receipts.get(values.slice(0, 3).join(':'))
      return { rows: receipt ? [receipt] : [] }
    }
    if (text.includes('insert into management_command_receipts')) {
      receipts.set(values.slice(0, 3).join(':'), { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[5])) })
    }
    if (text.includes('from device_registrations')) return { rows: [{ record: registration }] }
    if (text.includes('from job_executions')) return { rows: jobs }
    if (text.includes('from harness_executions')) return { rows: agents }
    return { rows: [] }
  })
  vi.spyOn(pool, 'connect').mockImplementation((async () => ({ query, release() {} })) as unknown as typeof pool.connect)
  const commands = new PostgresCommandCoordinator(pool)
  const audit = vi.spyOn(commands, 'recordDenied').mockResolvedValue(undefined)
  const service = new ComputerActivityService(pool, mainId, () => observed, commands)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return principal
  })
  const buildComputers = new BuildComputerSettings(pool, commands, async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
  const services = { computerActivity: service, buildComputers, commands } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'computer-activity-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  return { app, service, jobs, agents, principals, audit, connect, setPresence(value: DevicePresence | null) { observed = value },
    close: async () => { await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end() } }
}
afterEach(() => vi.restoreAllMocks())

it('serves authenticated HTTP and MCP activity with persisted readback and permission discovery', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_activity_list')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: {} })
    expect(capabilities.structuredContent).toMatchObject({ tools: expect.arrayContaining(['computer_activity_list']) })
    const read = await client.callTool({ name: 'computer_activity_list', arguments: {} })
    expect(read.isError).not.toBe(true)
    const result = ComputerActivityListSchema.parse(read.structuredContent)
    expect(result.activityComplete).toBe(true)
    expect(result.computers[1]).toMatchObject({ target, online: true, jobs: [job('visible', 'allowed').activity,
      job('secret', 'private').activity], agents: [agent('visible', 'allowed').activity, agent('secret', 'private').activity] })
    const http = await f.app.inject({ url: '/api/management/computers/activity', headers: { authorization: 'Bearer owner' } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(result)
    f.jobs.splice(0)
    f.agents.splice(0)
    const idle = await client.callTool({ name: 'computer_activity_list', arguments: {} })
    expect(ComputerActivityListSchema.parse(idle.structuredContent).computers[1]).toMatchObject({ jobs: [], agents: [] })
    expect((await f.app.inject({ url: '/api/management/computers/activity', headers: { authorization: 'Bearer unknown' } })).statusCode).toBe(401)
  } finally { await f.close() }
})
it('denies hidden MCP and HTTP calls and filters workspace activity without implying global idleness', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect('denied')
    expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_activity_list')
    const deniedCall = await reader.callTool({ name: 'computer_activity_list', arguments: {} })
    expect(deniedCall.isError).toBe(true)
    expect(f.audit).toHaveBeenCalledWith('denied', 'mcp', 'computer_activity_list', 'mcp:computer_activity_list')
    expect((await f.app.inject({ url: '/api/management/computers/activity',
      headers: { authorization: 'Bearer denied' } })).statusCode).toBe(403)
    const scopedClient = await f.connect('scoped')
    const read = await scopedClient.callTool({ name: 'computer_activity_list', arguments: {} })
    const result = ComputerActivityListSchema.parse(read.structuredContent)
    expect(result.activityComplete).toBe(false)
    expect(result.computers[1]?.jobs.map(value => value.id)).toEqual(['visible'])
    expect(result.computers[1]?.agents.map(value => value.id)).toEqual(['visible'])
    f.principals.set('scoped', { ...scoped, grants: [] })
    expect((await scopedClient.callTool({ name: 'computer_activity_list', arguments: {} })).isError).toBe(true)
  } finally { await f.close() }
})
it('bounds activity and separates missing presence from retained execution facts', async () => {
  const f = await fixture()
  try {
    f.jobs.push(...Array.from({ length: COMPUTER_ACTIVITY_LIMIT }, (_, index) => job(`job-${index}`, 'allowed')))
    f.setPresence(null)
    const result = await f.service.list(owner)
    expect(result.truncated).toBe(true)
    expect(result.activityComplete).toBe(false)
    expect(result.computers[1]?.online).toBe(false)
    expect(result.computers[1]?.jobs).toHaveLength(COMPUTER_ACTIVITY_LIMIT)
    expect(result.computers[1]?.agents).toHaveLength(2)
  } finally { await f.close() }
})

it('supports revisioned build role, allowance and priority edits through authenticated MCP with denied writes', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    const input = { target, commandId: 'build-preferences', expectedRevision: 0, buildEnabled: true,
      buildPriority: 100, buildRole: 'backup', buildAllowancePercent: 60 }
    const save = await client.callTool({ name: 'build_computer_update', arguments: input })
    expect(save.isError).not.toBe(true)
    const saved = BuildComputerStatusSchema.parse(save.structuredContent)
    expect(saved.preference).toMatchObject({ revision: 1, buildRole: 'backup', buildPriority: 100, buildAllowancePercent: 60 })
    const replay = await client.callTool({ name: 'build_computer_update', arguments: input })
    expect(BuildComputerStatusSchema.parse(replay.structuredContent)).toEqual(saved)
    const read = await client.callTool({ name: 'build_computer_get', arguments: { target } })
    expect(BuildComputerStatusSchema.parse(read.structuredContent)).toEqual(saved)
    const conflict = await client.callTool({ name: 'build_computer_update', arguments: { ...input, commandId: 'stale-save' } })
    expect(conflict.isError).toBe(true)
    const reader = await f.connect('settings-reader')
    const deniedSave = await reader.callTool({ name: 'build_computer_update', arguments: { ...input, expectedRevision: 1 } })
    expect(deniedSave.isError).toBe(true)
    const persisted = await reader.callTool({ name: 'build_computer_get', arguments: { target } })
    expect(BuildComputerStatusSchema.parse(persisted.structuredContent)).toEqual(saved)
  } finally { await f.close() }
})
