import { randomUUID } from 'node:crypto'
import { lstat, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ProviderAccountUpdateResultSchema, ProviderAccountsSnapshotSchema } from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, ownedTestPath } from '../../../test/helpers/testResources.js'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { LocalProviderCredentials } from './localCredentials.js'
import { NativeProviderAccountCommands, type AccountCommandInvocation, type ProviderAccountNativePort } from './nativeCommands.js'
import { ProviderAccountsRepository } from './repository.js'
import { ProviderAccountsService } from './service.js'
import { providerAccountEnvironment } from './environment.js'

const schema = `provider_accounts_${randomUUID().replaceAll('-', '')}`
let pool: pg.Pool
let admin: pg.Pool
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
}, 30_000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await pool?.end()
  if (admin) {
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
})

async function fixture() {
  const access = new PostgresAccessService(pool)
  const owner = await access.issue({ name: 'Owner', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
  const reader = await access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read'], scope: {} }] })
  const scoped = await access.issue({ name: 'Scoped', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['one'] } }] })
  const root = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `accounts-${randomUUID()}`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const credentials = new LocalProviderCredentials(root)
  const commands = new PostgresCommandCoordinator(pool)
  const statuses = new Map<string, 'signed-in' | 'signed-out' | 'login-pending'>()
  const native: ProviderAccountNativePort = {
    status: vi.fn(async ({ account }) => ({ status: statuses.get(account.id) ?? 'signed-out', identity: null })),
    login: vi.fn(async ({ account }) => { statuses.set(account.id, 'login-pending') }),
    logout: vi.fn(async ({ account }) => { statuses.set(account.id, 'signed-out') }),
    cancelLogin: vi.fn(async accountId => { statuses.delete(accountId) }), close: vi.fn(async () => {}),
  }
  const createService = () => new ProviderAccountsService(pool,
    new ProviderAccountsRepository(pool, () => credentials.hostId()), credentials, native, commands)
  const service = createService()
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    localHuman: { current: async () => owner.principal },
    operator: { access, services: { providerAccounts: service, commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => app.close())
  async function connect(token: string) {
    const client = new Client({ name: 'accounts-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    cleanups.push(() => client.close())
    return client
  }
  return { owner, reader, scoped, credentials, native, commands, service, createService, statuses, app, connect }
}

const command = (expectedRevision: number) => ({ expectedRevision, commandId: randomUUID() })
async function add(service: ProviderAccountsService, principal: ManagementPrincipal,
  provider: 'codex' | 'claude', authMode: 'subscription' | 'api-key', expectedRevision = 0) {
  return service.create(principal, 'http', { ...command(expectedRevision), provider, authMode, name: `${provider} account` })
}

it('supports the complete authenticated MCP account workflow with PostgreSQL readback after recreation', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const names = (await client.listTools()).tools.map(tool => tool.name)
  expect(names).toContain('provider_account_login')
  const input = { ...command(0), provider: 'codex', authMode: 'subscription', name: 'Personal' }
  const call = async (name: string, arguments_: Record<string, unknown>) =>
    ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({ name, arguments: arguments_ })))
  const created = await call('provider_account_create', input)
  expect(await call('provider_account_create', input)).toEqual({ ...created, replayed: true })
  const first = created.value.accounts[0]!
  const second = await call('provider_account_create', { ...command(1), provider: 'codex', authMode: 'subscription', name: 'Work' })
  const accountId = second.value.accounts[1]!.id
  await call('provider_account_rename', { ...command(2), accountId, name: 'Company' })
  await call('provider_account_default_set', { ...command(3), accountId })
  await call('provider_account_login', { ...command(4), accountId })
  expect(f.native.login).toHaveBeenCalledTimes(1)
  f.statuses.set(accountId, 'signed-in')
  await call('provider_account_refresh', { ...command(5), accountId })
  const read = ProviderAccountsSnapshotSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'provider_accounts_list', arguments: {} })))
  expect(read).toMatchObject({ revision: 6, accounts: [
    { id: first.id, isDefault: false }, { id: accountId, name: 'Company', isDefault: true, status: 'signed-in' },
  ] })
  expect(await f.createService().list(f.reader.principal)).toEqual(read)
  expect((await f.createService().resolve('codex'))?.accountId).toBe(accountId)
  await call('provider_account_logout', { ...command(6), accountId })
  expect((await f.service.list(f.reader.principal)).accounts[1]?.status).toBe('signed-out')
  const audit = await pool.query<{ action: string; outcome: string }>(
    'select action,outcome from management_audit where principal_id=$1', [f.owner.principal.id])
  expect(audit.rows).toContainEqual({ action: 'provider.account.default.set', outcome: 'succeeded' })
})

it('denies guessed MCP writes and scoped reads, HTTP writes and revoked live command replay', async () => {
  const f = await fixture()
  const client = await f.connect(f.reader.token)
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('provider_account_create')
  const input = { ...command(0), provider: 'claude', authMode: 'subscription', name: 'Denied' }
  expect((await client.callTool({ name: 'provider_account_create', arguments: input })).isError).toBe(true)
  const denied = await f.app.inject({ method: 'POST', url: '/api/provider-accounts',
    headers: { authorization: `Bearer ${f.reader.token}` }, payload: input })
  expect(denied.statusCode).toBe(403)
  await expect(f.service.list(f.scoped.principal)).rejects.toMatchObject({ status: 403 })
  const accepted = { ...input, commandId: randomUUID() }
  await f.service.create(f.owner.principal, 'http', accepted)
  await pool.query('update management_principals set grants=$2::jsonb where id=$1',
    [f.owner.principal.id, JSON.stringify(f.reader.principal.grants)])
  await expect(f.service.create(f.owner.principal, 'mcp', accepted)).rejects.toMatchObject({ status: 403 })
  const deniedAudits = await pool.query<{ outcome: string }>(
    'select outcome from management_audit where principal_id=$1', [f.reader.principal.id])
  expect(deniedAudits.rows).toContainEqual({ outcome: 'denied' })
})

it('keeps API keys local and private, rejects bearer provisioning and exposes only metadata through MCP', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  const apiKey = `sk-test-${randomUUID()}-${randomUUID()}`
  const input = { ...command(1), apiKey }
  const denied = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${accountId}/api-key`,
    headers: { authorization: `Bearer ${f.owner.token}` }, payload: input })
  expect(denied.statusCode).toBe(403)
  const response = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${accountId}/api-key`, payload: input })
  expect(response.statusCode).toBe(200)
  expect(response.body).not.toContain(apiKey)
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(apiKey)
  const keyInfo = await lstat(join(f.credentials.paths(accountId).userHome, 'api-key'))
  expect(keyInfo.mode & 0o777).toBe(0o600)
  const client = await f.connect(f.reader.token)
  const result = await client.callTool({ name: 'provider_accounts_list', arguments: {} })
  expect(JSON.stringify(result)).not.toContain(apiKey)
  expect(ProviderAccountsSnapshotSchema.parse(decodeMcpToolResult(result)).accounts[0]?.status).toBe('signed-in')
  const persisted = await pool.query('select to_jsonb(t) as record from application_settings t union all '
    + 'select to_jsonb(t) from application_setting_versions t union all select to_jsonb(t) '
    + 'from management_command_receipts t union all select to_jsonb(t) from management_audit t')
  expect(JSON.stringify(persisted.rows)).not.toContain(apiKey)
})

it('rejects stale revisions, foreign provider selections, missing homes and unsafe symlinks without fallback', async () => {
  const f = await fixture()
  const result = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = result.value.accounts[0]!.id
  await expect(f.service.rename(f.owner.principal, 'http', accountId, { ...command(0), name: 'Stale' }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.service.resolve('claude', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_MISMATCH' })
  await expect(f.service.resolve('codex', randomUUID())).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_NOT_FOUND' })
  const foreignRoot = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `foreign-${randomUUID()}`))
  const foreign = new LocalProviderCredentials(foreignRoot)
  const foreignService = new ProviderAccountsService(pool, new ProviderAccountsRepository(pool, () => foreign.hostId()), foreign, f.native, f.commands)
  cleanups.push(() => rm(foreignRoot, { recursive: true, force: true }))
  await expect(foreignService.resolve('codex', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_NOT_FOUND' })
  const home = f.credentials.paths(accountId).homePath
  await rm(home, { recursive: true })
  await symlink(f.credentials.paths(accountId).userHome, home)
  await expect(f.service.resolve('codex', accountId)).rejects.toMatchObject({ code: 'ACCOUNT_HOME_UNSAFE' })
})

it('restores local key state after a confirmed database rollback', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  const oldKey = `sk-old-${randomUUID()}`
  await f.service.provisionApiKey(f.owner.principal, accountId, { ...command(1), apiKey: oldKey })
  const repository = new ProviderAccountsRepository(pool, () => f.credentials.hostId())
  vi.spyOn(repository, 'write').mockRejectedValue(new Error('fixture persistence failure'))
  const service = new ProviderAccountsService(pool, repository, f.credentials, f.native, f.commands)
  await expect(service.provisionApiKey(f.owner.principal, accountId,
    { ...command(2), apiKey: `sk-new-${randomUUID()}` })).rejects.toThrow('fixture persistence failure')
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(oldKey)
  expect((await f.service.list(f.reader.principal)).revision).toBe(2)
})

it.each(['save', 'logout'] as const)('serializes %s compensation before a concurrent same-revision key save', async action => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  await f.service.provisionApiKey(f.owner.principal, accountId,
    { ...command(1), apiKey: `sk-original-${randomUUID()}` })
  const repository = new ProviderAccountsRepository(pool, () => f.credentials.hostId())
  vi.spyOn(repository, 'write').mockRejectedValue(new Error('fixture persistence failure'))
  const failingService = new ProviderAccountsService(pool, repository, f.credentials, f.native, f.commands)
  let releaseRestore!: () => void
  let enteredRestore!: () => void
  const restoreEntered = new Promise<void>(resolve => { enteredRestore = resolve })
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve })
  const restore = f.credentials.restore.bind(f.credentials)
  vi.spyOn(f.credentials, 'restore').mockImplementation(async backup => {
    enteredRestore()
    await restoreGate
    await restore(backup)
  })
  const mutation = action === 'logout'
    ? failingService.logout(f.owner.principal, 'http', accountId, command(2))
    : failingService.provisionApiKey(f.owner.principal, accountId,
      { ...command(2), apiKey: `sk-failing-${randomUUID()}` })
  const failed = mutation.catch(error => error)
  await restoreEntered
  const committedKey = `sk-committed-${randomUUID()}`
  let contenderSaved!: () => void
  const contenderWritten = new Promise<void>(resolve => { contenderSaved = resolve })
  const saveApiKey = f.credentials.saveApiKey.bind(f.credentials)
  vi.spyOn(f.credentials, 'saveApiKey').mockImplementation(async (id, apiKey) => {
    await saveApiKey(id, apiKey)
    if (apiKey === committedKey) contenderSaved()
  })
  const contender = f.service.provisionApiKey(f.owner.principal, accountId,
    { ...command(2), apiKey: committedKey })
  let waitingForMutation = true
  const waitForBlockedMutation = async () => {
    const deadline = Date.now() + 5000
    while (waitingForMutation && Date.now() < deadline) {
      const waiting = await pool.query<{ waiting: boolean }>(
        "select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting")
      if (waiting.rows[0]?.waiting) return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (waitingForMutation) throw new Error('The concurrent mutation did not wait for account ownership.')
  }
  try {
    await Promise.race([contenderWritten, waitForBlockedMutation()])
  } finally {
    waitingForMutation = false
    releaseRestore()
  }
  expect(await failed).toBeInstanceOf(Error)
  expect((await contender).value.revision).toBe(3)
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(committedKey)
  expect((await f.service.list(f.reader.principal)).revision).toBe(3)
})

it('invokes native login/status in the selected home and sanitizes provider output', async () => {
  const account = { id: randomUUID(), provider: 'claude' as const, name: 'Personal', authMode: 'subscription' as const,
    isDefault: true, status: 'signed-out' as const, identity: null, revision: 1 }
  const invocations: AccountCommandInvocation[] = []
  const native = new NativeProviderAccountCommands({ codex: 'fixture-codex', claude: 'fixture-claude' }, input => {
    invocations.push(input)
    return { completion: Promise.resolve({ code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', token: 'must-not-escape' }) }),
    stop: async () => {} }
  })
  const input = { account, homePath: '/owned/account/home', userHome: '/owned/account' }
  expect(await native.status(input)).toEqual({ status: 'signed-in', identity: 'user@example.com' })
  await native.login(input)
  await native.close()
  expect(invocations[1]?.args).toEqual(['auth', 'login'])
  expect(invocations[1]?.environment.CLAUDE_CONFIG_DIR).toBe(input.homePath)
  expect(invocations[1]?.environment.HOME).toBe(input.userHome)
  await native.status({ ...input, account: { ...account, provider: 'codex' } })
  expect(invocations[2]?.args).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login', 'status'])
  const environment = providerAccountEnvironment('claude', input.homePath, input.userHome, {
    OPENAI_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient', ANTHROPIC_AUTH_TOKEN: 'ambient',
    CLAUDE_CODE_OAUTH_TOKEN: 'ambient', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'ambient', DISPLAY: ':0',
  })
  expect(Object.keys(environment).filter(key => /API_KEY|TOKEN|BEDROCK|AWS_/.test(key))).toEqual([])
  expect(environment.DISPLAY).toBe(':0')
})
