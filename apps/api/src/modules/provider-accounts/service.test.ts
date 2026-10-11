import { randomUUID } from 'node:crypto'
import { lstat, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ProviderAccountUpdateResultSchema, ProviderAccountsSnapshotSchema,
  ProviderAccountPageSchema, ProviderAccountSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountAuthenticationOperationSchema, type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, ownedTestPath } from '../../../test/helpers/testResources.js'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { LocalProviderCredentials } from './localCredentials.js'
import { NativeProviderAccountCommands, type AccountCommandInvocation } from './nativeCommands.js'
import { ProviderAccountsRepository } from './repository.js'
import { ProviderAccountsService, type ProviderAccountOperationNativePort } from './service.js'
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
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read',
      'provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  const reader = await access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'provider_accounts:read'], scope: {} }] })
  const scoped = await access.issue({ name: 'Scoped', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'settings:update', 'provider_accounts:read',
      'provider_accounts:manage'], scope: { workspaceIds: ['one'] } }] })
  const root = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `accounts-${randomUUID()}`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const credentials = new LocalProviderCredentials(root)
  const commands = new PostgresCommandCoordinator(pool)
  const statuses = new Map<string, 'signed-in' | 'signed-out' | 'login-pending'>()
  const native: ProviderAccountOperationNativePort = {
    status: vi.fn(async ({ account }) => ({ status: statuses.get(account.id) ?? 'signed-out', identity: null })),
    login: vi.fn(async ({ account }) => { statuses.set(account.id, 'login-pending') }),
    logout: vi.fn(async ({ account }) => { statuses.set(account.id, 'signed-out') }),
    cancelLogin: vi.fn(async accountId => { statuses.delete(accountId) }), close: vi.fn(async () => {}),
    prepareAuthentication: vi.fn(async input => {
      if (input.operation.intent === 'sign-in') await native.login(input)
      else await native.logout(input)
      return { operationId: input.operation.id, binding: input.operation.binding,
        generation: input.operation.generation, sequence: input.operation.nativeSequence + 1,
        state: input.operation.intent === 'sign-in' ? 'awaiting-human' : 'completed',
        nativeClosed: input.operation.intent === 'sign-out' }
    }),
    observeAuthentication: vi.fn(async input => ({ operationId: input.operation.id,
      binding: input.operation.binding, generation: input.operation.generation,
      sequence: input.operation.nativeSequence + 1,
      state: statuses.get(input.account.id) === 'signed-in' ? 'completed' : 'awaiting-human',
      nativeClosed: statuses.get(input.account.id) === 'signed-in' })),
    cancelAuthentication: vi.fn(async input => ({ operationId: input.operation.id,
      binding: input.operation.binding, generation: input.operation.generation,
      sequence: input.operation.nativeSequence + 1, state: 'canceled', nativeClosed: true })),
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
  const failingService = new ProviderAccountsService(pool, repository, f.credentials, f.native, f.commands)
  let releaseRestore!: () => void
  let enteredRestore!: () => void
  const restoreEntered = new Promise<void>(resolve => { enteredRestore = resolve })
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve })
  vi.spyOn(repository, 'write').mockImplementation(async () => {
    if (action === 'logout') { enteredRestore(); await restoreGate }
    throw new Error('fixture persistence failure')
  })
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
  if (action === 'logout') expect(f.native.logout).not.toHaveBeenCalled()
  expect((await contender).value.revision).toBe(3)
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(committedKey)
  expect((await f.service.list(f.reader.principal)).revision).toBe(3)
})

it('invokes native login/status in the selected home and sanitizes provider output', async () => {
  const mainId = randomUUID()
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'claude',
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }, profileRef: 'qualified-profile', bindingRevision: 1, subject: null }
  const account = { binding, id: binding.accountId, provider: 'claude' as const, name: 'Personal', authMode: 'subscription' as const,
    isDefault: true, status: 'signed-out' as const, identity: null, revision: 1 }
  const invocations: AccountCommandInvocation[] = []
  const native = new NativeProviderAccountCommands({ selected: async input => ({ binding: input.account.binding!,
    binary: '/qualified/provider', profilePath: input.homePath, qualificationId: 'isolation-check', generation: 1,
    isolation: true, status: true, login: true, logout: true }) }, input => {
    invocations.push(input)
    return { completion: Promise.resolve({ code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', token: 'must-not-escape' }) }),
    stop: async () => {} }
  })
  const input = { account, homePath: '/owned/account/home', userHome: '/owned/account' }
  expect(await native.status(input)).toEqual({ status: 'signed-in', identity: 'user@example.com', subject: null })
  const operation = { id: randomUUID(), commandId: randomUUID(), inputHash: `sha256:${'a'.repeat(64)}`,
    binding, intent: 'sign-in' as const, state: 'reserved' as const, revision: 1, generation: 1, nativeSequence: 0,
    cancelRequested: false, nativeClosed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00.000Z', humanActionRequired: true }
  const login = await native.dispatch({ ...input, operation }, 'login', {
    recovery: { root: '/fixture/process-registry', owner: 'fixture-operation', launchId: randomUUID() },
  })
  await login.completion
  expect(invocations[1]?.args).toEqual(['auth', 'login'])
  expect(invocations[1]?.environment.CLAUDE_CONFIG_DIR).toBe(input.homePath)
  expect(invocations[1]?.environment.HOME).toBe(process.env.HOME)
  await native.status({ ...input, account: { ...account, provider: 'codex',
    binding: { ...binding, provider: 'codex' } } })
  expect(invocations[2]?.args).toEqual(['login', 'status'])
  await native.close()
  const environment = providerAccountEnvironment('claude', input.homePath, input.userHome, {
    OPENAI_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient', ANTHROPIC_AUTH_TOKEN: 'ambient',
    CLAUDE_CODE_OAUTH_TOKEN: 'ambient', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'ambient', DISPLAY: ':0',
  })
  expect(Object.keys(environment).filter(key => /API_KEY|TOKEN|BEDROCK|AWS_/.test(key))).toEqual([])
  expect(environment.DISPLAY).toBe(':0')
})

it('reads paginated accounts, registers a qualified profile and removes a default through authenticated MCP and HTTP', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const first = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = first.value.accounts[0]!.id
  await add(f.service, f.owner.principal, 'codex', 'subscription', 1)
  const page = ProviderAccountPageSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_accounts_page', arguments: { provider: 'codex', limit: 1 },
  })))
  expect(page.accounts).toHaveLength(1)
  expect(page.nextCursor).not.toBeNull()
  const next = await f.service.page(f.reader.principal, { provider: 'codex', limit: 1, cursor: page.nextCursor })
  expect(next.accounts).toHaveLength(1)
  expect(next.accounts[0]!.id).not.toBe(page.accounts[0]!.id)
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${accountId}`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  const read = ProviderAccountSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_get', arguments: { accountId },
  })))
  expect(http.statusCode).toBe(200)
  expect(http.json()).toEqual(read)
  f.native.registerProfile = vi.fn(async input => ({ profileRef: input.profileRef }))
  const registered = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_register', arguments: { ...command(2), provider: 'claude', authMode: 'subscription',
      name: 'Existing profile', profileRef: 'qualified-existing-profile', qualificationId: 'profile-check' },
  })))
  expect(registered.value.accounts.at(-1)?.binding?.profileRef).toBe('qualified-existing-profile')
  const removed = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_remove', arguments: { ...command(3), accountId },
  })))
  expect(removed.value.accounts.find(account => account.id === accountId)).toMatchObject({ isDefault: false })
  expect(removed.value.defaults?.find(value => value.provider === 'codex')?.accountId).toBeNull()
  expect((await f.createService().get(f.reader.principal, { accountId })).removedAt).toEqual(expect.any(String))
  await expect(f.createService().resolve('codex', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
  expect((await f.service.page(f.reader.principal, { provider: 'codex' })).accounts.map(account => account.id))
    .not.toContain(accountId)
})

it('prepares, rechecks and cancels one authentication operation through MCP with HTTP persisted readback', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const created = await add(f.service, f.owner.principal, 'claude', 'subscription')
  const accountId = created.value.accounts[0]!.id
  const input = { ...command(1), accountId, intent: 'sign-in' }
  const prepared = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_prepare', arguments: input,
  })))
  expect(prepared.value.state).toBe('awaiting-human')
  const replay = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_prepare', arguments: input,
  })))
  expect(replay.replayed).toBe(true)
  expect(replay.value.id).toBe(prepared.value.id)
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
  const status = ProviderAccountAuthenticationOperationSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_status', arguments: { operationId: prepared.value.id },
  })))
  const canceled = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_cancel', arguments: { ...command(status.revision), operationId: status.id },
  })))
  expect(canceled.value).toMatchObject({ id: status.id, state: 'canceled', cancelRequested: true, nativeClosed: true })
  const http = await f.app.inject({ method: 'POST', url: '/api/provider-accounts/authentication/status',
    headers: { authorization: `Bearer ${f.reader.token}` }, payload: { operationId: status.id } })
  expect(http.statusCode).toBe(200)
  expect(http.json()).toEqual(canceled.value)
  expect(await f.createService().authenticationStatus(f.reader.principal, { operationId: status.id })).toEqual(canceled.value)
  await expect(f.service.prepareAuthentication(f.owner.principal, 'mcp', accountId,
    { ...input, intent: 'sign-out' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
})

it('audits each denied HTTP and guessed MCP mutation without changing persisted state', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = created.value.accounts[0]!.id
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'http', accountId,
    { ...command(1), intent: 'sign-in' })
  const client = await f.connect(f.reader.token)
  const operations = [
    { tool: 'provider_account_remove', url: `/api/provider-accounts/${accountId}/remove`,
      input: { ...command(2), accountId } },
    { tool: 'provider_account_auth_prepare', url: `/api/provider-accounts/${accountId}/authentication`,
      input: { ...command(2), accountId, intent: 'sign-in' } },
    { tool: 'provider_account_auth_cancel', url: '/api/provider-accounts/authentication/cancel',
      input: { ...command(prepared.value.revision), operationId: prepared.value.id } },
    { tool: 'provider_account_register', url: '/api/provider-accounts/register',
      input: { ...command(2), provider: 'codex', authMode: 'subscription', name: 'Denied',
        profileRef: 'qualified-profile', qualificationId: 'qualified-proof' } },
  ]
  for (const operation of operations) {
    expect((await client.callTool({ name: operation.tool, arguments: operation.input })).isError).toBe(true)
    const payload = Object.fromEntries(Object.entries(operation.input).filter(([key]) => key !== 'accountId'))
    expect((await f.app.inject({ method: 'POST', url: operation.url,
      headers: { authorization: `Bearer ${f.reader.token}` }, payload })).statusCode).toBe(403)
  }
  const audits = await pool.query<{ outcome: string }>(
    'select outcome from management_audit where principal_id=$1', [f.reader.principal.id])
  expect(audits.rows.filter(row => row.outcome === 'denied')).toHaveLength(operations.length * 2)
  expect((await f.service.get(f.reader.principal, { accountId })).removedAt).toBeNull()
})

it('keeps scoped-default CAS independent from label edits and rejects another canonical installation', async () => {
  const f = await fixture()
  const first = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const second = await add(f.service, f.owner.principal, 'codex', 'subscription', 1)
  const accountId = second.value.accounts[1]!.id
  const defaultRevision = second.value.defaults!.find(value => value.provider === 'codex')!.revision
  await f.service.rename(f.owner.principal, 'http', first.value.accounts[0]!.id, { ...command(2), name: 'Renamed' })
  const changed = await f.service.setDefault(f.owner.principal, 'mcp', accountId,
    { ...command(2), expectedDefaultRevision: defaultRevision })
  expect(changed.value.defaults!.find(value => value.provider === 'codex')).toMatchObject({
    accountId, revision: defaultRevision + 1,
  })
  await expect(f.service.setDefault(f.owner.principal, 'http', accountId,
    { ...command(4), expectedDefaultRevision: defaultRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const target = { ...second.value.accounts[1]!.binding!.target, applicationInstallationId: randomUUID() }
  await expect(f.service.get(f.owner.principal, { accountId, target }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
})

it('detects reliable same-scope duplicates without merging and protects a used principal from replacement', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  let subject: string | null = 'qualified-provider-subject'
  let sequence = 0
  f.native.observeAccount = async input => ({ bindingRevision: input.account.binding!.bindingRevision,
    generation: 1, sequence: ++sequence, observedAt: new Date().toISOString(), status: 'signed-in',
    identity: 'display@example.test', readiness: 'ready', subject: subject ? { subject,
      provenance: 'qualified-native', qualificationId: 'native-identity-check', observedAt: new Date().toISOString() } : null })
  const observedFirst = await f.service.refresh(f.owner.principal, 'http', first.id, command(2))
  const observedSecond = await f.service.refresh(f.owner.principal, 'mcp', second.id, command(3))
  expect(observedSecond.value.accounts[1]!.possibleDuplicateAccountIds).toEqual([first.id])
  expect(observedSecond.value.accounts).toHaveLength(2)
  expect(observedSecond.value.accounts[1]!.binding!.profileRef).not.toBe(observedFirst.value.accounts[0]!.binding!.profileRef)
  const third = (await add(f.service, f.owner.principal, 'codex', 'subscription', 4)).value.accounts[2]!
  subject = null
  const emailOnly = await f.service.refresh(f.owner.principal, 'http', third.id, command(5))
  expect(emailOnly.value.accounts[2]!.binding!.subject).toBeNull()
  expect(emailOnly.value.accounts[2]!.possibleDuplicateAccountIds).toEqual([])
  const sql = await pool.connect()
  try {
    await sql.query('begin')
    const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
    await f.service.acceptedBindings.accept(sql, 'run-node', `accepted:${randomUUID()}`,
      { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: first.id })
    await sql.query('commit')
  } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
  subject = 'different-provider-subject'
  await expect(f.service.refresh(f.owner.principal, 'http', first.id, command(6)))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_PRINCIPAL_LOCKED' })
  await expect(f.service.prepareAuthentication(f.owner.principal, 'mcp', first.id,
    { ...command(6), intent: 'sign-in' })).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_PRINCIPAL_LOCKED' })
  expect((await f.createService().get(f.reader.principal, { accountId: first.id })).observation!.subject!.subject)
    .toBe('qualified-provider-subject')
})

it('returns distinct account-scoped models and rejects unqualified or mismatched catalogs without fallback', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  f.native.models = async input => ({ binding: input.account.binding!, generation: 1,
    observedAt: new Date().toISOString(), models: input.account.id === first.id ? [{ id: 'model-a', name: 'Model A' }] : [] })
  const client = await f.connect(f.reader.token)
  const { ProviderAccountModelsSchema } = await import('@foreman-code/contracts/provider-accounts')
  const models = ProviderAccountModelsSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_models', arguments: { accountId: first.id },
  })))
  expect(models.models.map(model => model.id)).toEqual(['model-a'])
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${second.id}/models`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  expect(http.statusCode).toBe(200)
  expect(ProviderAccountModelsSchema.parse(http.json()).models).toEqual([])
  f.native.models = async () => ({ ...models, binding: second.binding! })
  await expect(f.service.models(f.reader.principal, { accountId: first.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
})

it('enforces target restrictions at every delegation link through authenticated HTTP and MCP', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  const access = new PostgresAccessService(pool)
  const parent = await access.issue({ name: 'Scoped account owner', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: { providerAccountIds: [first.id] } }] })
  const child = await access.issue({ name: 'Delegated account caller', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  await pool.query('update management_principals set delegated_from=$2 where id=$1', [child.principal.id, parent.principal.id])
  const client = await f.connect(child.token)
  const permitted = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${first.id}`,
    headers: { authorization: `Bearer ${child.token}` } })
  expect(permitted.statusCode).toBe(200)
  expect(permitted.json().id).toBe(first.id)
  const denied = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${second.id}/remove`,
    headers: { authorization: `Bearer ${child.token}` }, payload: command(2) })
  expect(denied.statusCode).toBe(403)
  expect((await client.callTool({ name: 'provider_account_remove', arguments: { ...command(2), accountId: second.id } })).isError)
    .toBe(true)
  expect((await f.createService().get(f.reader.principal, { accountId: second.id })).removedAt).toBeNull()
  const audits = await pool.query<{ outcome: string }>(
    'select outcome from management_audit where principal_id=$1', [child.principal.id])
  expect(audits.rows.filter(row => row.outcome === 'denied')).toHaveLength(2)
})

it('does not adopt prior slot records after an application reinstall even when the native root is unchanged', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const otherMain = randomUUID()
  const recreated = f.createService()
  recreated.bindTarget(async () => ({ hostRef: { kind: 'main', mainId: otherMain },
    applicationInstallationId: otherMain, keyRevision: null, authorizationRevision: null }))
  await expect(recreated.get(f.owner.principal, { accountId: account.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
  await expect(recreated.resolve('codex', account.id)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
  expect((await f.createService().get(f.owner.principal, { accountId: account.id })).binding).toEqual(account.binding)
})
