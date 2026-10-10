import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  ProviderAccountApiKeyInputSchema, ProviderAccountCommandInputSchema,
  ProviderAccountCreateInputSchema, ProviderAccountIdSchema, ProviderAccountRenameInputSchema,
  type AccountProvider, type ProviderAccount, type ProviderAccountAuthMode,
  type ProviderAccountsSnapshot,
} from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { LocalProviderCredentials } from './localCredentials.js'
import type { ProviderAccountNativePort } from './nativeCommands.js'
import { ProviderAccountsRepository } from './repository.js'

export interface ResolvedProviderAccount {
  accountId: string
  homePath: string
  authMode: ProviderAccountAuthMode
  apiKey?: string
}
export interface ProviderAccountResolver {
  resolve(provider: AccountProvider, accountId?: string,
    options?: { sql: GraphSqlClient }): Promise<ResolvedProviderAccount | null>
}
type CommandSource = 'http' | 'mcp'
type Change = (snapshot: ProviderAccountsSnapshot) => Promise<void>

export class ProviderAccountsService implements ProviderAccountResolver {
  constructor(
    private readonly pool: pg.Pool,
    private readonly repository: ProviderAccountsRepository,
    private readonly credentials: LocalProviderCredentials,
    private readonly native: ProviderAccountNativePort,
    private readonly commands: PostgresCommandCoordinator,
  ) {}

  private async authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    action: 'settings:read' | 'settings:update' = 'settings:read'): Promise<void> {
    requireAuthorization(principal, 'settings:read')
    const current = await readLiveManagementPrincipal(sql, principal.id)
    requireAuthorization(current, 'settings:read')
    requireAuthorization(current, action)
  }

  async list(principal: ManagementPrincipal): Promise<ProviderAccountsSnapshot> {
    await this.authorize(this.pool, principal)
    const snapshot = await this.repository.read()
    for (const account of snapshot.accounts) Object.assign(account, await this.status(account))
    await this.authorize(this.pool, principal)
    return snapshot
  }

  private async status(account: ProviderAccount): Promise<Pick<ProviderAccount, 'status' | 'identity'>> {
    try {
      await this.credentials.assertAvailable(account.id)
      if (account.authMode === 'api-key') {
        const apiKey = await this.credentials.apiKey(account.id)
        return { status: apiKey ? 'signed-in' : 'signed-out', identity: null }
      }
      return await this.native.status({ account, ...this.credentials.paths(account.id) })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      return { status: 'unavailable', identity: null }
    }
  }

  private account(snapshot: ProviderAccountsSnapshot, accountId: string): ProviderAccount {
    ProviderAccountIdSchema.parse(accountId)
    const account = snapshot.accounts.find(value => value.id === accountId)
    if (!account) throw new DomainError('PROVIDER_ACCOUNT_NOT_FOUND', 'The account is unavailable on this computer.', 404)
    return account
  }

  private async change(principal: ManagementPrincipal, source: CommandSource, operation: string,
    input: { commandId: string; expectedRevision: number }, payload: unknown, change: Change,
    afterRollback?: () => Promise<void>) {
    requireAuthorization(principal, 'settings:update')
    requireAuthorization(principal, 'settings:read')
    const targetKey = await this.repository.key()
    return this.commands.execute({
      principal, source, operation, commandId: input.commandId, targetKey, payload,
      resourceLock: `provider-account-credentials:${targetKey}`,
      authorize: sql => this.authorize(sql, principal, 'settings:update'),
      perform: async sql => {
        const snapshot = await this.repository.lock(sql)
        if (snapshot.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Provider accounts changed. Refresh before saving.', 409)
        }
        await change(snapshot)
        return this.repository.write(sql, snapshot, input.expectedRevision)
      },
      ...(afterRollback ? { afterRollback } : {}),
    })
  }

  create(principal: ManagementPrincipal, source: CommandSource, raw: unknown) {
    const input = ProviderAccountCreateInputSchema.parse(raw)
    let createdId: string | undefined
    return this.change(principal, source, 'provider.account.create', input, input, async snapshot => {
      if (snapshot.accounts.length >= 100) throw new DomainError('ACCOUNT_LIMIT', 'The account limit has been reached.', 409)
      const account: ProviderAccount = { id: randomUUID(), provider: input.provider, name: input.name,
        authMode: input.authMode, isDefault: !snapshot.accounts.some(value => value.provider === input.provider),
        status: 'signed-out', identity: null, revision: snapshot.revision + 1 }
      await this.credentials.create(account)
      createdId = account.id
      snapshot.accounts.push(account)
    }, async () => {
      if (createdId) await this.credentials.removeCreatedHome(createdId)
    })
  }

  rename(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountRenameInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.rename', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      account.name = input.name
      account.revision = snapshot.revision + 1
    })
  }

  setDefault(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.default.set', input, { ...input, accountId }, async snapshot => {
      const selected = this.account(snapshot, accountId)
      await this.credentials.assertAvailable(accountId)
      for (const account of snapshot.accounts.filter(value => value.provider === selected.provider)) {
        if (account.isDefault === (account.id === accountId)) continue
        account.isDefault = account.id === accountId
        account.revision = snapshot.revision + 1
      }
    })
  }

  refresh(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.refresh', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      Object.assign(account, await this.status(account), { revision: snapshot.revision + 1 })
    })
  }

  login(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    let backup: Map<string, Buffer | null> | undefined
    return this.change(principal, source, 'provider.account.login', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      if (account.authMode !== 'subscription') {
        throw new DomainError('ACCOUNT_API_KEY_REQUIRED', 'Add an API key through the local app for this account.', 409)
      }
      backup = await this.credentials.backup(account)
      await this.native.login({ account, ...this.credentials.paths(accountId) })
      Object.assign(account, { status: 'login-pending', identity: null, revision: snapshot.revision + 1 })
    }, async () => {
      if (!backup) return
      await this.native.cancelLogin(accountId)
      await this.credentials.restore(backup)
    })
  }

  logout(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    let backup: Map<string, Buffer | null> | undefined
    return this.change(principal, source, 'provider.account.logout', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      backup = await this.credentials.backup(account)
      if (account.authMode === 'api-key') await this.credentials.clearApiKey(accountId)
      else await this.native.logout({ account, ...this.credentials.paths(accountId) })
      Object.assign(account, { status: 'signed-out', identity: null, revision: snapshot.revision + 1 })
    }, async () => { if (backup) await this.credentials.restore(backup) })
  }

  provisionApiKey(principal: ManagementPrincipal, accountId: string, raw: unknown) {
    const input = ProviderAccountApiKeyInputSchema.parse(raw)
    const { apiKey, ...command } = input
    const apiKeyDigest = createHash('sha256').update(apiKey).digest('hex')
    let backup: Map<string, Buffer | null> | undefined
    return this.change(principal, 'http', 'provider.account.key.provision', command,
      { ...command, accountId, apiKeyDigest }, async snapshot => {
        const account = this.account(snapshot, accountId)
        if (account.provider !== 'claude' || account.authMode !== 'api-key') {
          throw new DomainError('ACCOUNT_AUTH_MODE_MISMATCH', 'This account uses provider subscription sign-in.', 409)
        }
        backup = await this.credentials.backup(account)
        await this.credentials.saveApiKey(accountId, apiKey)
        Object.assign(account, { status: 'signed-in', identity: null, revision: snapshot.revision + 1 })
      }, async () => { if (backup) await this.credentials.restore(backup) })
  }

  async resolve(provider: AccountProvider, accountId?: string,
    options?: { sql: GraphSqlClient }): Promise<ResolvedProviderAccount | null> {
    const snapshot = await this.repository.read(options?.sql)
    const account = accountId ? this.account(snapshot, accountId)
      : snapshot.accounts.find(value => value.provider === provider && value.isDefault)
    if (!account) return null
    if (account.provider !== provider) {
      throw new DomainError('PROVIDER_ACCOUNT_MISMATCH', 'The selected account belongs to another provider.', 409)
    }
    await this.credentials.assertAvailable(account.id)
    const apiKey = account.authMode === 'api-key' ? await this.credentials.apiKey(account.id) : undefined
    if (account.authMode === 'api-key' && !apiKey) {
      throw new DomainError('PROVIDER_ACCOUNT_SIGN_IN_REQUIRED', 'Add an API key to the selected account in Settings.', 409)
    }
    return { accountId: account.id, homePath: this.credentials.paths(account.id).homePath,
      authMode: account.authMode, ...(apiKey ? { apiKey } : {}) }
  }

  close(): Promise<void> { return this.native.close() }
}
