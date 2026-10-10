import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { GitHubLoginRunner } from '../src/modules/computers/githubLogin.js'
import { ComputerGitHubService } from '../src/modules/computers/github.js'
import { GitHubLoginStateSchema,
  type GitHubLoginRequest } from '@foreman-code/contracts/computer-accounts'
import { COMPUTER_ACCOUNTS_NAMESPACE, ComputerAccountsListSchema, type ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
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

async function fixture(options: {
  githubSetupFails?: boolean
  githubLocal?: Pick<GitHubLoginRunner, 'handle'>
  loseRemoteResponse?: boolean
} = {}) {
  const pool = new pg.Pool()
  const jobs = [job('visible', 'allowed'), job('secret', 'private')]
  const agents = [agent('visible', 'allowed'), agent('secret', 'private')]
  let observed: DevicePresence | null = { binding: { mainId, deviceId, workerInstallationId: workerId,
    keyRevision: 1, authorizationRevision: 1, bootId: '44444444-4444-4444-8444-444444444444',
    connectionGeneration: 1, connectionEpoch: '55555555-5555-4555-8555-555555555555' },
  phase: 'ready', dispatch: true, transfer: true, appVersion: '1', protocolVersion: 1,
  lastSeenAt: '2026-10-06T00:00:00Z' }
  let preference = { target, revision: '0', build_enabled: false, build_priority: 50,
    build_allowance_percent: 100 }
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
        build_priority: Number(values[4]), build_allowance_percent: Number(values[5]) }
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
  const audited = vi.spyOn(commands, 'recordAudit').mockResolvedValue(undefined)
  const service = new ComputerActivityService(pool, mainId, () => observed, commands)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return principal
  })
  const buildComputers = new BuildComputerSettings(pool, commands, async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
  const accountsOf = (email: string, githubAccount: string | null = 'octo-owner'): ComputerAccounts => ({ observedAt: '2026-10-07T00:00:00.000Z', accounts: [
    { tool: 'codex', installed: true, signedIn: true, account: email, details: ['ChatGPT'] },
    { tool: 'github', installed: true, signedIn: githubAccount !== null, account: githubAccount, details: [] },
  ] })
  const deviceAnswers = { calls: 0, email: 'laptop@example.com', githubAccount: 'octo-owner' as string | null }
  const mainProbes = { calls: 0, githubAccount: 'octo-owner' as string | null }
  const computerAccounts = new ComputerAccountsService(pool, mainId, () => ({
    capabilities: () => observed ? [{ namespace: COMPUTER_ACCOUNTS_NAMESPACE, mainCanRequest: true }] : [],
    request: async () => { deviceAnswers.calls++; return { payload: accountsOf(deviceAnswers.email, deviceAnswers.githubAccount) } },
  }), commands, async () => { mainProbes.calls++; return accountsOf('main@example.com', mainProbes.githubAccount) })
  const githubCalls: { where: string; request: GitHubLoginRequest }[] = []
  const githubState = (request: GitHubLoginRequest) => {
    if (request.operation === 'setup-git') options.githubSetupFails = false
    let state = options.githubSetupFails ? 'git-setup-failed' : 'signed-in'
    if (request.operation === 'login-start') state = 'waiting'
    return GitHubLoginStateSchema.parse(request.operation === 'logout'
    ? { loginId: null, state: 'signed-out', code: null, verificationUrl: null, expiresAt: null, account: null, message: null }
    : { loginId: '66666666-6666-4666-8666-666666666666', state,
      code: request.operation === 'login-start' ? 'AB12-CD34' : null,
      verificationUrl: request.operation === 'login-start' ? 'https://github.com/login/device' : null,
      expiresAt: '2026-10-07T00:15:00.000Z', account: request.operation === 'login-start' ? null : 'octo-owner', message: null })
  }
  const computerGitHub = new ComputerGitHubService(pool, mainId, () => ({
    captureRequest: () => observed ? {
      binding: observed.binding,
      request: async payload => {
        githubCalls.push({ where: 'device', request: payload as GitHubLoginRequest })
        deviceAnswers.githubAccount = (payload as GitHubLoginRequest).operation === 'logout' ? null : 'signed-in-owner'
        if (options.loseRemoteResponse) throw new Error('Response lost after account change')
        return { payload: githubState(payload as GitHubLoginRequest) }
      },
    } : undefined,
  }), commands, {
    local: { handle: async request => {
      githubCalls.push({ where: 'main', request })
      if (options.githubLocal) return options.githubLocal.handle(request)
      mainProbes.githubAccount = request.operation === 'logout' ? null : 'signed-in-owner'
      return githubState(request)
    } },
    accountChanged: target => computerAccounts.invalidate(target),
  })
  const services = { computerActivity: service, computerAccounts, computerGitHub, buildComputers, commands } as unknown as OperatorServices
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
  return { app, service, jobs, agents, principals, audit, audited, connect, deviceAnswers, mainProbes, githubCalls, setPresence(value: DevicePresence | null) { observed = value },
    close: async () => { await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end() } }
}
afterEach(() => vi.restoreAllMocks())

it('serves authenticated HTTP and MCP activity with persisted readback and permission discovery', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_activity_list')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(capabilities.isError, JSON.stringify(capabilities)).not.toBe(true)
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining(['computer_activity_list']) })
    const read = await client.callTool({ name: 'computer_activity_list', arguments: {} })
    expect(read.isError).not.toBe(true)
    const result = ComputerActivityListSchema.parse(decodeMcpToolResult(read))
    expect(result.activityComplete).toBe(true)
    expect(result.computers[1]).toMatchObject({ target, online: true, jobs: [job('visible', 'allowed').activity,
      job('secret', 'private').activity], agents: [agent('visible', 'allowed').activity, agent('secret', 'private').activity] })
    const http = await f.app.inject({ url: '/api/management/computers/activity', headers: { authorization: 'Bearer owner' } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(result)
    f.jobs.splice(0)
    f.agents.splice(0)
    const idle = await client.callTool({ name: 'computer_activity_list', arguments: {} })
    expect(ComputerActivityListSchema.parse(decodeMcpToolResult(idle)).computers[1]).toMatchObject({ jobs: [], agents: [] })
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
    const result = ComputerActivityListSchema.parse(decodeMcpToolResult(read))
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

it('supports revisioned build allowance and priority edits through authenticated MCP with denied writes', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    const input = { target, commandId: 'build-preferences', expectedRevision: 0, buildEnabled: true,
      buildPriority: 100, buildAllowancePercent: 60 }
    const save = await client.callTool({ name: 'build_computer_update', arguments: input })
    expect(save.isError).not.toBe(true)
    const saved = BuildComputerStatusSchema.parse(decodeMcpToolResult(save))
    expect(saved.preference).toMatchObject({ revision: 1, buildPriority: 100, buildAllowancePercent: 60 })
    expect(saved.preference).not.toHaveProperty('buildRole')
    const replay = await client.callTool({ name: 'build_computer_update', arguments: input })
    expect(BuildComputerStatusSchema.parse(decodeMcpToolResult(replay))).toEqual(saved)
    const read = await client.callTool({ name: 'build_computer_get', arguments: { target } })
    expect(BuildComputerStatusSchema.parse(decodeMcpToolResult(read))).toEqual(saved)
    const conflict = await client.callTool({ name: 'build_computer_update', arguments: { ...input, commandId: 'stale-save' } })
    expect(conflict.isError).toBe(true)
    const reader = await f.connect('settings-reader')
    const deniedSave = await reader.callTool({ name: 'build_computer_update', arguments: { ...input, expectedRevision: 1 } })
    expect(deniedSave.isError).toBe(true)
    const persisted = await reader.callTool({ name: 'build_computer_get', arguments: { target } })
    expect(BuildComputerStatusSchema.parse(decodeMcpToolResult(persisted))).toEqual(saved)
  } finally { await f.close() }
})

it('reads every computer signed-in account through HTTP and MCP, caching probes and denying readers without settings', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('computer_accounts_list')
    const read = ComputerAccountsListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computer_accounts_list', arguments: {} }))))
    expect(read.computers.map(computer => computer.accounts?.accounts[0]?.account)).toEqual(['main@example.com', 'laptop@example.com'])
    const http = await f.app.inject({ url: '/api/management/computers/accounts', headers: { authorization: 'Bearer owner' } })
    expect(ComputerAccountsListSchema.parse(http.json())).toEqual(read)
    expect([f.mainProbes.calls, f.deviceAnswers.calls]).toEqual([1, 1])
    f.deviceAnswers.email = 'switched@example.com'
    const refreshed = ComputerAccountsListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computer_accounts_list',
      arguments: { refresh: true } }))))
    expect(refreshed.computers[1]?.accounts?.accounts[0]?.account).toBe('switched@example.com')
    f.setPresence(null)
    const offline = ComputerAccountsListSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computer_accounts_list',
      arguments: { refresh: true } }))))
    expect(offline.computers[1]?.accounts).toBeNull()
    const reader = await f.connect('denied')
    expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_accounts_list')
    expect((await reader.callTool({ name: 'computer_accounts_list', arguments: {} })).isError).toBe(true)
    expect((await f.app.inject({ url: '/api/management/computers/accounts',
      headers: { authorization: 'Bearer denied' } })).statusCode).toBe(403)
  } finally { await f.close() }
})

it('starts, follows and ends GitHub sign-in on Main and a paired computer, denying settings readers', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    const mainTarget = { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }
    const startCall = await client.callTool({ name: 'computer_github_login_start', arguments: { target: mainTarget } })
    const started = GitHubLoginStateSchema.parse(decodeMcpToolResult(startCall))
    expect(started).toMatchObject({ state: 'waiting', code: 'AB12-CD34' })
    const done = GitHubLoginStateSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'computer_github_login_status',
      arguments: { target, loginId: started.loginId } }))))
    expect(done).toMatchObject({ state: 'signed-in', account: 'octo-owner' })
    const logout = await client.callTool({ name: 'computer_github_logout', arguments: { target, expectedAccount: 'octo-owner' } })
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult(logout)).state).toBe('signed-out')
    expect(f.githubCalls.map(call => [call.where, call.request.operation])).toEqual([
      ['main', 'login-start'], ['device', 'login-status'], ['device', 'logout']])
    const stale = await client.callTool({ name: 'computer_github_login_start',
      arguments: { target: { ...target, authorizationRevision: 2 } } })
    expect(JSON.stringify(stale)).toContain('COMPUTER_NOT_FOUND')
    const reader = await f.connect('settings-reader')
    expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('computer_github_login_start')
    expect((await reader.callTool({ name: 'computer_github_login_start', arguments: { target } })).isError).toBe(true)
    expect(f.githubCalls).toHaveLength(3)
    expect(f.audited.mock.calls.map(call => [call[2], call[4]])).toEqual([
      ['computer_github_login_start', 'succeeded'], ['computer_github_logout', 'succeeded']])
    expect(f.audit).toHaveBeenCalledWith('settings-reader', 'mcp', 'computer_github_login_start',
      'mcp:computer_github_login_start')
  } finally { await f.close() }
})



it('refreshes the server account cache after GitHub account changes through authenticated MCP', async () => {
  const f = await fixture()
  const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  try {
    const client = await f.connect('owner')
    const read = async () => ComputerAccountsListSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'computer_accounts_list', arguments: {},
    }))))
    expect((await read()).computers[0]!.accounts!.accounts.find(value => value.tool === 'github')?.account).toBe('octo-owner')
    await client.callTool({ name: 'computer_github_login_start', arguments: { target: mainTarget } })
    await client.callTool({ name: 'computer_github_login_status', arguments: {
      target: mainTarget, loginId: '66666666-6666-4666-8666-666666666666',
    } })
    expect((await read()).computers[0]!.accounts!.accounts.find(value => value.tool === 'github')?.account).toBe('signed-in-owner')
    await client.callTool({ name: 'computer_github_logout', arguments: { target, expectedAccount: 'octo-owner' } })
    expect((await read()).computers[1]!.accounts!.accounts.find(value => value.tool === 'github')?.signedIn).toBe(false)
    const reader = await f.connect('settings-reader')
    expect((await reader.callTool({ name: 'computer_github_logout', arguments: { target: mainTarget, expectedAccount: 'octo-owner' } })).isError).toBe(true)
    expect((await read()).computers[0]!.accounts!.accounts.find(value => value.tool === 'github')?.signedIn).toBe(true)
  } finally { await f.close() }
})


it('discovers Git setup retry through MCP and preserves write permission checks', async () => {
  const f = await fixture({ githubSetupFails: true })
  const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  try {
    const client = await f.connect('owner')
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toContain('computer_github_setup_git')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining(['computer_github_setup_git']) })
    const input = { target: mainTarget, loginId: '66666666-6666-4666-8666-666666666666' }
    const status = await client.callTool({ name: 'computer_github_login_status', arguments: input })
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult(status))).toMatchObject({ state: 'git-setup-failed', account: 'octo-owner' })
    const reader = await f.connect('settings-reader')
    expect((await reader.callTool({ name: 'computer_github_setup_git', arguments: input })).isError).toBe(true)
    expect(f.githubCalls).toHaveLength(1)
    const retry = await client.callTool({ name: 'computer_github_setup_git', arguments: input })
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult(retry))).toMatchObject({ state: 'signed-in', account: 'octo-owner' })
    expect(f.audited).toHaveBeenCalledWith('owner', 'mcp', 'computer_github_setup_git', `main:${mainId}`, 'succeeded', { state: 'signed-in' })
  } finally { await f.close() }
})


it('orders an authenticated MCP account switch after pending credential removal', async () => {
  let account: string | null = 'owner'
  let release!: () => void
  const removing = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  const child = new EventEmitter()
  const stderr = new PassThrough()
  const runner = new GitHubLoginRunner({ now: Date.now, probe: {
    environment: {}, find: async name => name === 'gh' ? '/fixture/gh' : null, readText: async () => null,
    run: async (_binary, args) => {
      if (args[1] === 'logout') {
        events.push('logout')
        await removing
        account = null
      }
      if (args[1] === 'status') {
        if (!account) events.push('verified signed-out')
        return { code: 0, stderr: '', stdout: JSON.stringify({ hosts: { 'github.com': account
          ? [{ active: true, login: account, state: 'success' }] : [] } }) }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }, spawn: () => {
    events.push('login')
    queueMicrotask(() => stderr.write('one-time code: AB12-CD34\n'))
    return { stdout: new PassThrough(), stderr, stdin: new PassThrough(),
      kill: () => { child.emit('exit', null); return true },
      once: (event: string, listener: (...values: unknown[]) => void) => child.once(event, listener) } as never
  } })
  const f = await fixture({ githubLocal: runner })
  const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  try {
    const client = await f.connect('owner')
    const logout = client.callTool({ name: 'computer_github_logout', arguments: { target: mainTarget, expectedAccount: 'owner' } })
    await vi.waitFor(() => expect(events).toContain('logout'))
    const start = client.callTool({ name: 'computer_github_login_start', arguments: { target: mainTarget } })
    await vi.waitFor(() => expect(f.githubCalls.map(call => call.request.operation)).toEqual(['logout', 'login-start']))
    expect(events).not.toContain('login')
    const reader = await f.connect('settings-reader')
    expect((await reader.callTool({ name: 'computer_github_login_start', arguments: { target: mainTarget } })).isError).toBe(true)
    release()
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult((await logout))).state).toBe('signed-out')
    const waiting = GitHubLoginStateSchema.parse(decodeMcpToolResult((await start)))
    expect(events).toEqual(['logout', 'verified signed-out', 'login'])
    account = 'switched-owner'
    child.emit('exit', 0)
    await vi.waitFor(async () => expect(GitHubLoginStateSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'computer_github_login_status', arguments: { target: mainTarget, loginId: waiting.loginId },
    }))))).toMatchObject({ state: 'signed-in', account: 'switched-owner' }))
  } finally {
    release()
    runner.close()
    await f.close()
  }
})


it('audits a lost remote logout response as uncertain and reads back its effect through MCP', async () => {
  const f = await fixture({ loseRemoteResponse: true })
  try {
    const client = await f.connect('owner')
    expect((await client.callTool({ name: 'computer_github_logout',
      arguments: { target, expectedAccount: 'octo-owner' } })).isError).toBe(true)
    expect(f.audited.mock.calls.map(call => call[4])).toEqual(['uncertain'])
    const read = ComputerAccountsListSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'computer_accounts_list', arguments: { refresh: true },
    })))
    expect(read.computers[1]!.accounts!.accounts.find(value => value.tool === 'github')?.signedIn).toBe(false)
  } finally { await f.close() }
})

it('does not audit a known successful GitHub mutation as failed when storing its success audit fails', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    f.audited.mockRejectedValueOnce(new Error('Audit storage unavailable'))
    expect((await client.callTool({ name: 'computer_github_logout',
      arguments: { target, expectedAccount: 'octo-owner' } })).isError).toBe(true)
    expect(f.audited.mock.calls.map(call => call[4])).toEqual(['succeeded'])
    const read = ComputerAccountsListSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'computer_accounts_list', arguments: { refresh: true },
    })))
    expect(read.computers[1]!.accounts!.accounts.find(value => value.tool === 'github')?.signedIn).toBe(false)
  } finally { await f.close() }
})


it('supersedes a pending GitHub login through authenticated MCP when a later logout completes', async () => {
  let release!: () => void
  const lookup = new Promise<void>(resolve => { release = resolve })
  let lookups = 0
  const spawn = vi.fn()
  const runner = new GitHubLoginRunner({ now: Date.now, spawn, probe: {
    environment: {}, readText: async () => null,
    find: async () => {
      if (++lookups === 1) await lookup
      return '/fixture/gh'
    },
    run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ hosts: { 'github.com': [] } }) }),
  } })
  const f = await fixture({ githubLocal: runner })
  const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }
  try {
    const client = await f.connect('owner')
    const start = client.callTool({ name: 'computer_github_login_start', arguments: { target: mainTarget } })
    await vi.waitFor(() => expect(lookups).toBe(1))
    const result = await client.callTool({ name: 'computer_github_logout',
      arguments: { target: mainTarget, expectedAccount: null } })
    expect(GitHubLoginStateSchema.parse(decodeMcpToolResult(result)).state).toBe('signed-out')
    release()
    expect((await start).isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    release()
    runner.close()
    await f.close()
  }
})
